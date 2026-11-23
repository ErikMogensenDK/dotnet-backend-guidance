---
name: read-only-queries-and-projections
description: Make read-only EF Core queries fast by skipping change tracking and selecting only the columns an endpoint returns.
keywords: [AsNoTracking, AsNoTrackingWithIdentityResolution, UseQueryTrackingBehavior, QueryTrackingBehavior.NoTracking, Select, projection, DTO, ToListAsync, FirstOrDefaultAsync, AsAsyncEnumerable, FindAsync, CancellationToken, keyset pagination]
---

# Read-Only Queries and Projections

By default, EF Core queries track every entity they return. That means snapshot copies, identity resolution, and work in `DetectChanges` on every later `SaveChanges`. Read endpoints don't need any of it. Loading whole entities and then mapping them to DTOs in memory (with `ToList()` followed by `Select` or `mapper.Map`) also fetches every column, including large text and blob columns, and pulls in navigations you never return. Instead, project to a DTO with `Select` inside the query so the generated SQL reads only the columns you need, and run it asynchronously with the request's `CancellationToken`.

## Implementation

1. For endpoints that return data, write `Select(x => new SomeDto(...))` **before** materializing. Projections that contain no entity instances are never tracked, so `AsNoTracking()` is redundant on them.
2. When you need whole entities read-only (for example, to run domain logic on them), add `AsNoTracking()`. Switch to `AsNoTrackingWithIdentityResolution()` only when the result graph repeats the same entity many times and you need one shared instance per entity.
3. For a read-heavy context, you can set `UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking)` in options and opt back in with `AsTracking()` on queries that save changes.
4. Use navigations inside the projection (`o.Customer.Name`, `o.Lines.Count`). EF translates them to joins or subqueries. `Include` is ignored when the query projects to a non-entity type.
5. Always use the async terminal operators with the token: `ToListAsync(ct)`, `FirstOrDefaultAsync(ct)`, `CountAsync(ct)`, `AnyAsync(ct)`. To stream large results, use `AsAsyncEnumerable()` with `await foreach`.
6. For deep paging, prefer keyset pagination (`Where(o => o.Id > afterId).OrderBy(o => o.Id).Take(n)`) over a large `Skip`. The HTTP contract for pagination is covered in a separate API guide.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;

namespace Shop.Orders;

public sealed record OrderSummaryDto(int Id, string CustomerName, DateTimeOffset PlacedAt, int LineCount, decimal Total);

public sealed class OrderQueries(ShopDbContext db)
{
    // Keyset page of summaries: only five columns are selected; nothing is tracked.
    public Task<List<OrderSummaryDto>> GetPageAsync(int afterId, int pageSize, CancellationToken ct) =>
        db.Orders
            .Where(o => o.Id > afterId)
            .OrderBy(o => o.Id)
            .Take(pageSize)
            .Select(o => new OrderSummaryDto(
                o.Id,
                o.Customer.Name,
                o.PlacedAt,
                o.Lines.Count,
                o.Lines.Sum(l => l.UnitPrice * l.Quantity)))
            .ToListAsync(ct);

    // Whole entity, read-only (e.g. to run domain rules), without change-tracking cost.
    public Task<Order?> GetForPricingAsync(int id, CancellationToken ct) =>
        db.Orders.AsNoTracking()
            .Include(o => o.Lines)
            .FirstOrDefaultAsync(o => o.Id == id, ct);

    // Streaming export: rows are processed one at a time instead of buffered in a List.
    public async Task ExportAsync(Stream output, CancellationToken ct)
    {
        await using var writer = new StreamWriter(output);
        await foreach (var row in db.Orders.Select(o => new { o.Id, o.PlacedAt }).AsAsyncEnumerable().WithCancellation(ct))
            await writer.WriteLineAsync($"{row.Id},{row.PlacedAt:O}");
    }
}

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}

public sealed class Order
{
    public int Id { get; set; }
    public DateTimeOffset PlacedAt { get; set; }
    public Customer Customer { get; set; } = null!;
    public List<OrderLine> Lines { get; } = [];
}

public sealed class Customer { public int Id { get; set; } public required string Name { get; set; } }

public sealed class OrderLine
{
    public int Id { get; set; }
    public decimal UnitPrice { get; set; }
    public int Quantity { get; set; }
}
```

## Best Practices & Constraints

- **MANDATORY**: Put `Where`, `OrderBy`, `Take` and `Select` before `ToListAsync`. Anything after materialization runs in memory over every row that was fetched.
- **MANDATORY**: Pass the request or job `CancellationToken` to every async EF call.
- **MANDATORY**: Use a stable, unique `OrderBy` (add the key as a tiebreaker) whenever you use `Take`, `Skip` or keyset paging.
- **DO NOT** call `.ToList()` or `.AsEnumerable()` and then filter or project. Don't use sync `ToList()`, `First()` or `Count()` in ASP.NET Core code either. They block threads.
- **DO NOT** materialize entities just to map them with `mapper.Map<TDto>(entity)`. Project in the query instead (or use your mapper's `IQueryable` projection feature).
- **DO NOT** pass an entity to a C# method inside `Select` (for example, `Select(o => ToDto(o))`). EF can't translate the method, so it loads the full entity, client-evaluates the call, and tracks the entity. Inline the `new Dto(...)` expression instead.
- **DO NOT** write `FindAsync(id, ct)`. The parameter is `params object[] keyValues`, so the token is treated as a second key value. Use `FindAsync([id], ct)`. Also note that `FindAsync` always tracks the entity, so for read-only lookups use `AsNoTracking().FirstOrDefaultAsync(...)`.
- **DO NOT** add `AsNoTracking()` to queries whose entities you then modify and save. Updates on untracked entities are silently ignored.

## Version notes

- `AsNoTrackingWithIdentityResolution` and `QueryTrackingBehavior.NoTrackingWithIdentityResolution`: **EF Core 5.0+**. Before 5.0, no-tracking queries did identity resolution implicitly.
- EF Core 3.0+ throws if a non-translatable expression appears anywhere except the final `Select`. EF Core 2.x silently evaluated it on the client.
- EF Core 10 (.NET 10) translates the new LINQ `LeftJoin`/`RightJoin` operators. On older versions, use `GroupJoin` + `SelectMany` + `DefaultIfEmpty`, or navigation properties in the projection.
- EF Core 10 translates `ids.Contains(x.Id)` to a padded list of scalar parameters by default. EF Core 8–9 sent a single JSON array parameter. If plans regress, use `UseParameterizedCollectionMode(...)` or `EF.Parameter`/`EF.Constant` per query.

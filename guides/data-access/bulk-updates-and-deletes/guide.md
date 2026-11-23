---
name: bulk-updates-and-deletes
description: Update or delete many rows with a single SQL statement, and insert many rows efficiently, instead of loading entities and saving them one by one.
keywords: [ExecuteUpdateAsync, ExecuteDeleteAsync, ExecuteUpdate, ExecuteDelete, SetProperty, UpdateSettersBuilder, AddRange, SaveChangesAsync, MaxBatchSize, ChangeTracker.Clear, SaveChangesInterceptor, bulk insert, SqlBulkCopy, BeginBinaryImportAsync]
---

# Bulk Updates and Deletes

The classic EF pattern loads every matching entity, changes or removes it in memory, then calls `SaveChanges`. That pulls the full rows over the network, tracks each one, and sends one `UPDATE`/`DELETE` per row. `ExecuteUpdateAsync` and `ExecuteDeleteAsync` turn a LINQ query into a single set-based `UPDATE`/`DELETE` that runs immediately. These methods bypass the change tracker entirely, so `SaveChanges` interceptors, audit stamping, EF cascade rules and automatic concurrency checks don't run. Use them deliberately.

## Implementation

1. Filter with LINQ, then call `ExecuteDeleteAsync(ct)` or `ExecuteUpdateAsync(s => s.SetProperty(x => x.Prop, value), ct)`. The second argument of `SetProperty` can be a constant or a lambda that references the row (`x => x.Views + 1`). Chain `SetProperty` calls to update several columns.
2. Both methods return the number of affected rows. Use it for existence checks, or for hand-rolled optimistic concurrency (`Where(x => x.Id == id && x.Version == expected)`, where `0` means a conflict).
3. Set audit columns (`UpdatedAt`, `UpdatedBy`) explicitly in `SetProperty`. A `SaveChangesInterceptor` won't do it, because only `IDbCommandInterceptor` sees these commands.
4. Each call is its own statement and is auto-committed. To make several bulk calls, or a bulk call plus `SaveChangesAsync`, atomic, wrap them in `BeginTransactionAsync`. With a retrying execution strategy, wrap that transaction in `CreateExecutionStrategy().ExecuteAsync` (see the transactions guide).
5. Don't use tracked entities after a bulk call in the same context. They are stale, and a later `SaveChanges` will overwrite the bulk change. Use a fresh context, or call `ChangeTracker.Clear()`.
6. **Inserts** have no `ExecuteInsert`. Call `AddRange` on the whole batch and then **one** `SaveChangesAsync`. EF batches the inserts (up to 42 statements per round trip on SQL Server by default, configurable with `MaxBatchSize`). For very large imports, save in chunks and call `ChangeTracker.Clear()` between chunks. For hundreds of thousands of rows, use the provider's bulk copy (`SqlBulkCopy`, Npgsql `BeginBinaryImportAsync`).

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;

namespace Shop.Maintenance;

public sealed class OrderMaintenance(ShopDbContext db, TimeProvider clock)
{
    public async Task<int> ExpireStaleAsync(bool alsoFlagForReview, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var cutoff = now.AddDays(-7);

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Single UPDATE ... WHERE; setters can be conditional (EF Core 10 statement lambda).
        var expired = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending && o.CreatedAt < cutoff)
            .ExecuteUpdateAsync(s =>
            {
                s.SetProperty(o => o.Status, OrderStatus.Expired);
                s.SetProperty(o => o.UpdatedAt, now);           // interceptors won't stamp this for you
                if (alsoFlagForReview)
                    s.SetProperty(o => o.ReviewCount, o => o.ReviewCount + 1);
            }, ct);

        // Single DELETE ... WHERE; database FK cascades apply, EF's in-memory cascade does not.
        await db.CartItems.Where(c => c.AddedAt < cutoff).ExecuteDeleteAsync(ct);

        await tx.CommitAsync(ct);
        return expired;
    }

    public async Task ImportAsync(IEnumerable<Order> orders, CancellationToken ct)
    {
        foreach (var chunk in orders.Chunk(1_000))
        {
            db.Orders.AddRange(chunk);
            await db.SaveChangesAsync(ct);   // batched INSERTs, one call per chunk, not per row
            db.ChangeTracker.Clear();        // keep the tracker small across chunks
        }
    }
}

public enum OrderStatus { Pending, Paid, Expired }

public sealed class Order
{
    public int Id { get; set; }
    public OrderStatus Status { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public int ReviewCount { get; set; }
}

public sealed class CartItem { public int Id { get; set; } public DateTimeOffset AddedAt { get; set; } }

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<CartItem> CartItems => Set<CartItem>();
}
```

## Best Practices & Constraints

- **MANDATORY**: Use `ExecuteUpdateAsync`/`ExecuteDeleteAsync` whenever you change rows based on a predicate rather than on loaded domain state.
- **MANDATORY**: Wrap multiple bulk statements in an explicit transaction when they must succeed or fail together.
- **MANDATORY**: Remember that global query filters (for example soft delete) apply to bulk statements. Add `IgnoreQueryFilters()` deliberately when a job must touch filtered rows.
- **DO NOT** write `foreach (var x in await q.ToListAsync()) { x.Flag = true; } await SaveChangesAsync();` for set-based changes.
- **DO NOT** call `SaveChangesAsync()` inside a loop for each inserted or updated row.
- **DO NOT** rely on `SaveChangesInterceptor`, `SavingChanges` events, domain-event dispatch in `SaveChanges`, or the change tracker's soft-delete rewriting for bulk operations. None of them run.
- **DO NOT** expect concurrency tokens to be checked automatically by bulk methods. Put the token in the `Where` and check the returned row count.
- **DO NOT** reference navigations inside `SetProperty` value lambdas, or update more than one table per call. Neither is supported.
- **DO NOT** use third-party "bulk extensions" for plain update/delete-by-predicate on EF Core 7+. The built-ins cover it.

## Version notes

- `ExecuteUpdate`/`ExecuteDelete` (and the async versions): **EF Core 7.0+**, relational providers only. On EF Core 6 or earlier, use `ExecuteSqlInterpolatedAsync` with a parameterized `UPDATE`/`DELETE`, or a third-party library.
- **EF Core 9**: `ExecuteUpdate` can set complex type properties.
- **EF Core 10**: the setters parameter is a regular `Action<UpdateSettersBuilder<T>>` instead of an expression tree, which allows the conditional setters shown above. This is a source-breaking change for code that hand-built `Expression<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>`. EF Core 10 also supports `ExecuteUpdate` on properties inside JSON-mapped complex types.
- `ChangeTracker.Clear()`: **EF Core 5.0+**. On older versions, create a new context per chunk.
- `TimeProvider` (used in the example for testable time) requires **.NET 8+**.

---
name: pagination-and-filtering
description: Design paginated, filterable list endpoints with a bounded page size, stable ordering and an opaque next-page cursor.
keywords: [pagination, keyset pagination, cursor pagination, seek pagination, offset pagination, page size, limit, nextCursor, AsParameters, Base64Url, OrderBy, ThenBy, Take, Skip, filtering, sorting, allowlist, Link header]
---

# Paginate and Filter List Endpoints

The usual first version of a list endpoint is `GET /api/orders?page=3&pageSize=1000` backed by `Skip((page - 1) * pageSize)` and a `COUNT(*)`. It has no upper bound on page size and no deterministic order. Deep pages get slower, and rows shift between pages when data changes. Unbounded endpoints that return the whole table are worse. Make every list endpoint paginated from day one: an enforced maximum `limit`, a stable order that ends on a unique key, and an opaque `nextCursor` (keyset pagination). Offset paging is acceptable only for small, mostly static data or admin UIs that need page numbers. (For the EF Core query side, see the data-access pagination guide.)

## Implementation

1. Accept `limit` and `cursor` query parameters, plus explicit filter parameters (`status`, `customerId`, `createdAfter`). Bind them with an `[AsParameters]` record.
2. Enforce bounds: default `limit` (for example 25), maximum (for example 100). Reject `limit > max` or `< 1` with a `400` validation problem (or document that you clamp it). Never let the client disable the limit.
3. Define one deterministic sort that ends with a unique tiebreaker: `ORDER BY CreatedAt DESC, Id DESC`. If you offer `sort=`, accept only an allowlist of values, each mapped to a fixed ordering that includes the tiebreaker.
4. Keyset query: decode the cursor into the last row's sort key values, filter `WHERE (CreatedAt, Id) < (@lastCreatedAt, @lastId)`, apply the same ordering, and `Take(limit + 1)`. The extra row tells you whether there is a next page without a `COUNT`.
5. Build `nextCursor` from the last returned item, serialize it (JSON), and Base64Url-encode it so clients treat it as opaque. Return `null` when there are no more rows.
6. Response shape: `{ "items": [...], "nextCursor": "..." | null }`. Optionally also send an RFC 8288 `Link: <...>; rel="next"` header. Leave out `totalCount` by default. If a UI needs it, make it opt-in (`includeTotal=true`) or approximate, because `COUNT(*)` on large filtered tables is often slower than the page query.
7. A cursor is only valid with the filters and sort that produced it. Include those (or a hash of them) in the cursor and return `400` if they differ, or document that clients must resend identical filters.
8. Return `400` (validation problem) for malformed cursors and unknown filter or sort values, not `500` or an empty page.

## Example Code

```csharp
using System.Buffers.Text;
using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation();
var app = builder.Build();

var orders = Enumerable.Range(1, 500)
    .Select(i => new Order(i, $"customer-{i % 7}", i % 3 == 0 ? "shipped" : "open", DateTimeOffset.UnixEpoch.AddMinutes(i / 2)))
    .ToList(); // stands in for a DbSet<Order>; the query below translates to SQL in EF Core

app.MapGet("/api/orders", Results<Ok<Page<OrderDto>>, ValidationProblem> ([AsParameters] OrderQuery q) =>
{
    var query = orders.AsQueryable();
    if (q.Status is not null) query = query.Where(o => o.Status == q.Status);

    if (q.Cursor is not null)
    {
        if (!OrderCursor.TryDecode(q.Cursor, out var c) || c.Status != q.Status)
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { [nameof(q.Cursor)] = ["Invalid or expired cursor."] });

        query = query.Where(o => o.CreatedAt < c.CreatedAt || (o.CreatedAt == c.CreatedAt && o.Id < c.Id));
    }

    var rows = query
        .OrderByDescending(o => o.CreatedAt).ThenByDescending(o => o.Id) // stable: unique tiebreaker last
        .Take(q.Limit + 1)                                                // one extra row = "has next page"
        .Select(o => new OrderDto(o.Id, o.Customer, o.Status, o.CreatedAt))
        .ToList();

    string? next = null;
    if (rows.Count > q.Limit)
    {
        rows.RemoveAt(rows.Count - 1);
        var last = rows[^1];
        next = OrderCursor.Encode(new OrderCursor(last.CreatedAt, last.Id, q.Status));
    }

    return TypedResults.Ok(new Page<OrderDto>(rows, next));
});

app.Run();

public record OrderQuery(
    [Range(1, 100)] int Limit = 25,   // default 25, hard maximum 100
    string? Cursor = null,
    [AllowedValues(null, "open", "shipped")] string? Status = null);

public record Page<T>(IReadOnlyList<T> Items, string? NextCursor);
public record OrderDto(int Id, string Customer, string Status, DateTimeOffset CreatedAt);
public record Order(int Id, string Customer, string Status, DateTimeOffset CreatedAt);

public record OrderCursor(DateTimeOffset CreatedAt, int Id, string? Status)
{
    public static string Encode(OrderCursor cursor) =>
        Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(cursor));

    public static bool TryDecode(string value, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out OrderCursor? cursor)
    {
        cursor = null;
        try { cursor = JsonSerializer.Deserialize<OrderCursor>(Base64Url.DecodeFromChars(value)); }
        catch (Exception e) when (e is FormatException or JsonException) { }
        return cursor is not null;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Every collection endpoint must have a server-enforced maximum page size. Validate `limit` and reject or clamp out-of-range values.
- **MANDATORY**: Order by a deterministic key that ends with a unique column (`Id`). Ordering by a non-unique column alone (`CreatedAt`, `Name`) duplicates and skips rows across pages.
- **MANDATORY**: Treat cursors as opaque and untrusted input. Decode defensively, and return `400` for invalid ones. If a cursor must not be tampered with or reveal internal values, protect it with `IDataProtector` instead of plain Base64Url.
- **DO NOT** return unbounded lists (`return await db.Orders.ToListAsync()`) from public endpoints, even if the table is small today.
- **DO NOT** use `page`/`pageSize` offset paging for large or frequently changing collections, infinite scroll, or sync/export clients. `OFFSET` scans and discards rows, and inserts shift results between pages.
- **DO NOT** run `COUNT(*)` on every page request "for the UI".
- **DO NOT** accept arbitrary sort or filter expressions (`?sort=anyProperty`, raw dynamic LINQ strings, `OrderBy(q.Sort)` via reflection). Map an allowlist of named options to fixed expressions. Use OData or GraphQL only if you deliberately adopt them.
- **DO NOT** put raw database IDs/offsets into cursors when clients will parse them. Once clients rely on the format, you can't change it.
- Keep the response envelope consistent across all list endpoints (`items` + `nextCursor`) and document it in OpenAPI with a generic `Page<T>` record.

## Version notes

- `[AsParameters]`: .NET 7. Minimal API validation of the `[AsParameters]` record (`[Range]`, `[AllowedValues]`): .NET 10 with `AddValidation()`. On older versions, validate `limit` manually and return `TypedResults.ValidationProblem`.
- `System.Buffers.Text.Base64Url`: .NET 9. On .NET 8, use `WebEncoders.Base64UrlEncode`/`Base64UrlDecode` from `Microsoft.AspNetCore.WebUtilities`.
- `[AllowedValues]`/`[DeniedValues]`/`[Length]` validation attributes: .NET 8.
- EF Core translates the keyset predicate above to SQL. Index the sort columns (`CreatedAt DESC, Id DESC`) or keyset paging loses its advantage.

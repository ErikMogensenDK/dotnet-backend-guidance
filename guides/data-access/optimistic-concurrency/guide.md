---
name: optimistic-concurrency
description: Prevent lost updates when two users edit the same record by using concurrency tokens and returning a conflict response.
keywords: [DbUpdateConcurrencyException, Timestamp, rowversion, IsRowVersion, IsConcurrencyToken, ConcurrencyCheck, xmin, uint Version, Npgsql.EntityFrameworkCore.PostgreSQL, OriginalValue, GetDatabaseValuesAsync, ETag, If-Match, 409 Conflict, 412 Precondition Failed]
---

# Optimistic Concurrency

Without a concurrency token, EF Core's `UPDATE ... WHERE Id = @id` is last-write-wins: two users who load the same row will silently overwrite each other's changes. Configure a **concurrency token**. EF then adds it to the `WHERE` clause of every `UPDATE`/`DELETE` and throws `DbUpdateConcurrencyException` when no row matched. In web APIs the version must travel to the client and come back. The most common bug is assigning the client's version to the entity's *current* value. EF compares the *original* value, so the check never fires.

## Implementation

1. Add a database-generated token:
   - **SQL Server:** `[Timestamp] public byte[] Version { get; set; }` (or `.IsRowVersion()`) maps to `rowversion`, which changes automatically on every update.
   - **PostgreSQL (Npgsql):** `[Timestamp] public uint Version { get; set; }` (or `.IsRowVersion()`) maps to the `xmin` system column. No migration column is created.
   - **Other databases, or app-controlled tokens:** use `[ConcurrencyCheck]` or `.IsConcurrencyToken()` on a property such as `Guid Version`, and assign a new value yourself on every change.
2. Return the token to the client in the response DTO (base64 for `byte[]`) or as an `ETag` header.
3. On update, load the entity and then set `db.Entry(entity).Property(e => e.Version).OriginalValue = clientVersion;` before applying the changes. If you `Attach` a detached entity built from the request, its `Version` is already the original value.
4. Catch `DbUpdateConcurrencyException` around `SaveChangesAsync` and translate it at the API boundary: **409 Conflict** when the version came in the body, or **412 Precondition Failed** when the client sent `If-Match`. Use Problem Details. You can also map it centrally in an `IExceptionHandler`.
5. To resolve conflicts on the server instead (merge or retry), use `ex.Entries`. Call `entry.GetDatabaseValuesAsync(ct)`, decide which values win, call `entry.OriginalValues.SetValues(dbValues)`, and save again. A `null` result from `GetDatabaseValuesAsync` means the row was deleted.

## Example Code

```csharp
// Program.cs
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Shop.Products;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop")));
var app = builder.Build();

app.MapGet("/products/{id:int}", async Task<Results<Ok<ProductDto>, NotFound>> (int id, ShopDbContext db, CancellationToken ct) =>
    await db.Products.Where(p => p.Id == id)
            .Select(p => new ProductDto(p.Id, p.Name, p.Price, Convert.ToBase64String(p.Version)))
            .FirstOrDefaultAsync(ct) is { } dto
        ? TypedResults.Ok(dto)
        : TypedResults.NotFound());

app.MapPut("/products/{id:int}", async Task<Results<NoContent, NotFound, Conflict<ProblemDetails>>> (
    int id, UpdateProductRequest req, ShopDbContext db, CancellationToken ct) =>
{
    var product = await db.Products.FirstOrDefaultAsync(p => p.Id == id, ct);
    if (product is null) return TypedResults.NotFound();

    // Compare against the version the client saw, not the one just loaded.
    db.Entry(product).Property(p => p.Version).OriginalValue = Convert.FromBase64String(req.Version);
    product.Name = req.Name;
    product.Price = req.Price;

    try
    {
        await db.SaveChangesAsync(ct);   // UPDATE ... WHERE Id = @id AND Version = @originalVersion
        return TypedResults.NoContent();
    }
    catch (DbUpdateConcurrencyException)
    {
        return TypedResults.Conflict(new ProblemDetails
        {
            Title = "The product was modified by someone else.",
            Detail = "Reload the product and apply your changes again.",
            Status = StatusCodes.Status409Conflict,
        });
    }
});

app.Run();

// Products.cs
using System.ComponentModel.DataAnnotations;
using Microsoft.EntityFrameworkCore;

namespace Shop.Products;

public sealed record ProductDto(int Id, string Name, decimal Price, string Version);
public sealed record UpdateProductRequest(string Name, decimal Price, string Version);

public sealed class Product
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public decimal Price { get; set; }

    [Timestamp]                       // SQL Server rowversion; on PostgreSQL use: [Timestamp] public uint Version
    public byte[] Version { get; set; } = [];
}

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder b) =>
        b.Entity<Product>().Property(p => p.Price).HasPrecision(18, 2);
}
```

## Best Practices & Constraints

- **MANDATORY**: Every aggregate that users edit concurrently needs a concurrency token. Prefer database-generated ones (`rowversion`, `xmin`).
- **MANDATORY**: Round-trip the token through the client, and set it as the **original** value before `SaveChangesAsync`.
- **MANDATORY**: Map `DbUpdateConcurrencyException` to 409 (version in body) or 412 (`If-Match`/ETag), never to 500.
- **DO NOT** write `product.Version = clientVersion;` on a tracked entity. It changes the current value, EF still compares the freshly loaded original value, and the conflict goes undetected.
- **DO NOT** "fix" conflicts by catching the exception, reloading, and blindly saving again. That's last-write-wins with extra steps.
- **DO NOT** use `UseXminAsConcurrencyToken()` on Npgsql 7+. It's obsolete. Map a regular `uint` CLR property with `[Timestamp]`/`IsRowVersion()`. A shadow property doesn't survive detach/attach round-trips.
- **DO NOT** expect `ExecuteUpdateAsync`/`ExecuteDeleteAsync` to check tokens. Add `&& x.Version == expected` to the `Where` and treat `0` affected rows as a conflict.
- **DO NOT** treat `DbUpdateConcurrencyException` as a duplicate-key error. Inserts don't normally raise it. Unique violations surface as `DbUpdateException` wrapping a provider exception.

## Version notes

- `[Timestamp]`, `IsRowVersion`, `IsConcurrencyToken` and `DbUpdateConcurrencyException` exist in every EF Core version.
- **Npgsql EF provider 7.0+**: a `uint` property with `[Timestamp]`/`IsRowVersion()` maps to `xmin`. Provider 6.x and earlier used the now-obsolete `UseXminAsConcurrencyToken()`.
- `TypedResults` and `Results<T1, T2, ...>` require **.NET 7+**. `IExceptionHandler` for central mapping requires **.NET 8+**.
- SQLite has no auto-updating row version. Use an application-managed token (`IsConcurrencyToken()` on a `Guid` that you regenerate on every save).

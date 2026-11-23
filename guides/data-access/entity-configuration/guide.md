---
name: entity-configuration
description: Configure the EF Core model explicitly (keys, column sizes, indexes, conversions and value objects) in separate configuration classes, without cluttering domain entities.
keywords: [IEntityTypeConfiguration, ApplyConfigurationsFromAssembly, OnModelCreating, ConfigureConventions, ModelConfigurationBuilder, HavePrecision, HaveMaxLength, HaveConversion, HasConversion, ComplexProperty, ComplexCollection, ComplexType, OwnsOne, ToJson, HasIndex, IsUnique, HasMaxLength, HasPrecision, value object]
---

# Entity Configuration

EF Core's conventions are permissive. Unconfigured `string` properties become `nvarchar(max)` on SQL Server (`text` on PostgreSQL), `decimal` properties get the provider default with only a warning, enums are stored as integers, and you get no indexes beyond keys and foreign keys. A single 2,000-line `OnModelCreating`, or entities covered in `[Column]`/`[MaxLength]` attributes, is hard to review. Put each entity's mapping in its own `IEntityTypeConfiguration<T>`, set global defaults once in `ConfigureConventions`, and model value objects as **complex types** so the domain classes stay plain C#.

## Implementation

1. Create one `IEntityTypeConfiguration<T>` per aggregate or entity and load them all with `modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly)`.
2. In `ConfigureConventions(ModelConfigurationBuilder b)`, set defaults: `b.Properties<string>().HaveMaxLength(256)`, `b.Properties<decimal>().HavePrecision(18, 2)`, `b.Properties<OrderStatus>().HaveConversion<string>()`, and `HaveConversion<TConverter>()` for strongly typed IDs. Per-property configuration overrides these.
3. In each configuration, set the key (`HasKey`), required and length facets for columns that matter, unique and lookup indexes (`HasIndex(...).IsUnique()`, composite indexes in query-filter order), and delete behavior (`OnDelete`) for relationships.
4. Model value objects (Money, Address) with `ComplexProperty(...)`. They're stored as columns in the owner's table, or as one JSON column with `.ToJson()`. Use `ComplexCollection(..., c => c.ToJson())` for lists of value objects. Use owned types (`OwnsOne`/`OwnsMany`) only when you need what complex types can't do, such as a separate table or navigations inside the value.
5. Keep entities persistence-agnostic. EF can bind to constructors, set private setters and backing fields, and map collections exposed as `IReadOnlyCollection<T>` over a private `List<T>` field (`Navigation(...).UsePropertyAccessMode(PropertyAccessMode.Field)` when the field name isn't conventional).
6. Enable nullable reference types. EF treats `string` as required and `string?` as optional, so the column nullability matches your annotations.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Shop.Data;

// Domain: no EF attributes, encapsulated collection, value objects as records.
public enum OrderStatus { Pending, Paid, Shipped }
public sealed record Money(decimal Amount, string Currency);
public sealed record Address(string Street, string City, string PostCode, string Country);

public sealed class Order
{
    private readonly List<OrderLine> _lines = [];
    private Order() { }                                  // for EF
    public Order(string number, Address shipTo) => (Number, ShipTo) = (number, shipTo);

    public int Id { get; private set; }
    public string Number { get; private set; } = null!;
    public OrderStatus Status { get; private set; }
    public Address ShipTo { get; private set; } = null!;
    public Money Total { get; private set; } = new(0m, "EUR");
    public List<string> Tags { get; private set; } = [];
    public IReadOnlyCollection<OrderLine> Lines => _lines;
}

public sealed class OrderLine
{
    public int Id { get; private set; }
    public required string Sku { get; init; }
    public int Quantity { get; init; }
}

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void ConfigureConventions(ModelConfigurationBuilder b)
    {
        b.Properties<string>().HaveMaxLength(256);          // no accidental nvarchar(max)
        b.Properties<decimal>().HavePrecision(18, 2);
        b.Properties<OrderStatus>().HaveConversion<string>().HaveMaxLength(32);
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder) =>
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
}

internal sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("Orders");
        b.HasKey(o => o.Id);
        b.Property(o => o.Number).HasMaxLength(20);
        b.HasIndex(o => o.Number).IsUnique();
        b.HasIndex(o => new { o.Status, o.Id });            // supports WHERE Status = ... ORDER BY Id

        b.ComplexProperty(o => o.ShipTo, a =>              // columns ShipTo_Street, ShipTo_City, ...
        {
            a.Property(x => x.PostCode).HasMaxLength(16);
            a.Property(x => x.Country).HasMaxLength(2);
        });
        b.ComplexProperty(o => o.Total, m => m.Property(x => x.Currency).HasMaxLength(3));
        // Tags (List<string>) maps as a primitive collection by convention (JSON on SQL Server, text[] on PostgreSQL).

        b.HasMany(o => o.Lines).WithOne().HasForeignKey("OrderId").IsRequired().OnDelete(DeleteBehavior.Cascade);
        b.Navigation(o => o.Lines).UsePropertyAccessMode(PropertyAccessMode.Field);
    }
}

internal sealed class OrderLineConfiguration : IEntityTypeConfiguration<OrderLine>
{
    public void Configure(EntityTypeBuilder<OrderLine> b) => b.Property(l => l.Sku).HasMaxLength(64);
}
```

## Best Practices & Constraints

- **MANDATORY**: Give every string column a deliberate maximum length, either through a convention default or per property. Leave `max` only for columns that really hold large text.
- **MANDATORY**: Configure the precision of `decimal` (money) columns explicitly.
- **MANDATORY**: Add indexes for foreign keys that you filter on, unique business keys, and the columns behind frequent `Where`/`OrderBy` combinations.
- **DO NOT** put all mappings inline in `OnModelCreating`.
- **DO NOT** model new value objects as owned types (`OwnsOne`/`OwnsMany`) on EF Core 10. Complex types cover table splitting, JSON, optional values and collections, have value semantics (they can be shared and compared by value), and work with `ExecuteUpdate`. On EF Core 8–9, use complex types for required single values and owned types for the rest.
- **DO NOT** store enums as integers by default when other systems or humans read the database. Convert them to strings with a bounded length.
- **DO NOT** add public setters or parameterless public constructors to domain types just for EF. Private setters, private constructors and backing fields all work.
- **DO NOT** use `Guid.NewGuid()`, `DateTime.Now` or other non-deterministic values in `HasData`. They cause a model change on every build. Use `UseSeeding`/`UseAsyncSeeding` (EF Core 9+) for dynamic seed data.

## Version notes

- `IEntityTypeConfiguration<T>`: EF Core 2.0. `ApplyConfigurationsFromAssembly`: EF Core 2.2. `[Index]` attribute and `UsePropertyAccessMode` on navigations: EF Core 5.0.
- `ConfigureConventions` (pre-convention configuration: `HaveMaxLength`, `HavePrecision`, `HaveConversion`): **EF Core 6.0+**. On earlier versions, loop over `modelBuilder.Model.GetEntityTypes()` in `OnModelCreating`.
- Complex types (`ComplexProperty`, `[ComplexType]`) and primitive collections (`List<string>`): **EF Core 8.0+**. Complex types in 8–9 must be required, non-collection classes. On EF Core 7 or earlier, use `OwnsOne`.
- **EF Core 10**: optional (nullable) complex types (they need at least one required property), `struct` complex types, complex types mapped to JSON with `.ToJson()`, and `ComplexCollection` (JSON only). Before EF Core 10, use owned types with `ToJson()` (EF Core 7+) for JSON documents.

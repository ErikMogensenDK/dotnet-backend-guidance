---
name: dbcontext-lifetime-and-pooling
description: Register and scope EF Core DbContext instances correctly for web requests, background services and parallel work without threading bugs.
keywords: [DbContext, AddDbContext, AddDbContextPool, AddDbContextFactory, AddPooledDbContextFactory, IDbContextFactory, CreateDbContextAsync, PooledDbContextFactory, BackgroundService, IServiceScopeFactory, InvalidOperationException, "A second operation started on this context", Microsoft.EntityFrameworkCore]
---

# DbContext Lifetime, Pooling and Factories

A `DbContext` is a short-lived unit of work: one context per request or job, then dispose it. It is **not thread-safe**, and EF Core does not support running two operations on the same instance at once. The common mistakes are injecting a scoped context into a singleton or `BackgroundService` (a captive dependency that lives for the whole process and grows its change tracker without limit), sharing one context across `Task.WhenAll`, and keeping per-request state on a pooled context. All of these break under load with `InvalidOperationException: A second operation started on this context...` or silently corrupt data.

## Implementation

1. **Web requests:** register with `AddDbContext<T>` (scoped by default). For hot paths, use `AddDbContextPool<T>` instead. It reuses context instances (`poolSize` defaults to 1024) and resets EF's state between uses. Context pooling and ADO.NET connection pooling are separate things.
2. **Singletons, `BackgroundService`, Blazor Server, or several units of work in one scope:** register `AddDbContextFactory<T>` or `AddPooledDbContextFactory<T>`. Inject `IDbContextFactory<T>` (a singleton) and create one context per unit of work with `await using var db = await factory.CreateDbContextAsync(ct);`. Factory-created contexts are **not** disposed by DI.
3. **Parallel queries:** give each concurrent operation its own context from the factory. Never start two async operations on the same context without awaiting the first.
4. **Need both a scoped context and a pooled factory?** Register `AddPooledDbContextFactory<T>` and add `AddScoped(sp => sp.GetRequiredService<IDbContextFactory<T>>().CreateDbContext())`. DI then disposes the context, which returns it to the pool. (`AddDbContextFactory<T>` already registers the context type as scoped for you.)
5. A pooled context must have a single public constructor that takes only `DbContextOptions<T>`. Don't inject scoped services into it, and don't use `OnConfiguring` for per-request values. If you need per-request data such as a tenant ID, set it on the context in a scoped wrapper factory.

## Example Code

```csharp
// Program.cs
using Microsoft.EntityFrameworkCore;
using Shop.Data;

var builder = WebApplication.CreateBuilder(args);
var cs = builder.Configuration.GetConnectionString("Shop")
    ?? throw new InvalidOperationException("Missing connection string 'Shop'.");

// One pool; the factory is used by singletons/background work, the scoped context by endpoints.
builder.Services.AddPooledDbContextFactory<ShopDbContext>(o => o.UseSqlServer(cs));
builder.Services.AddScoped(sp =>
    sp.GetRequiredService<IDbContextFactory<ShopDbContext>>().CreateDbContext());
builder.Services.AddHostedService<ArchiveOrdersJob>();

var app = builder.Build();
app.MapGet("/orders/open-count", (ShopDbContext db, CancellationToken ct) =>
    db.Orders.CountAsync(o => !o.IsArchived, ct));
app.Run();

// Data.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}

public sealed class Order
{
    public int Id { get; set; }
    public bool IsArchived { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public decimal Total { get; set; }
}

public sealed class ArchiveOrdersJob(
    IDbContextFactory<ShopDbContext> dbFactory, ILogger<ArchiveOrdersJob> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            // New, short-lived context per tick, never one context for the service's lifetime.
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);
            var cutoff = DateTimeOffset.UtcNow.AddYears(-1);
            var archived = await db.Orders
                .Where(o => !o.IsArchived && o.CreatedAt < cutoff)
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.IsArchived, true), stoppingToken);
            logger.LogInformation("Archived {Count} orders", archived);
        }
    }
}

public sealed class DashboardQueries(IDbContextFactory<ShopDbContext> dbFactory)
{
    public async Task<(int Open, decimal Revenue)> GetAsync(CancellationToken ct)
    {
        // One context per concurrent operation.
        await using var db1 = await dbFactory.CreateDbContextAsync(ct);
        await using var db2 = await dbFactory.CreateDbContextAsync(ct);
        var open = db1.Orders.CountAsync(o => !o.IsArchived, ct);
        var revenue = db2.Orders.SumAsync(o => o.Total, ct);
        await Task.WhenAll(open, revenue);
        return (await open, await revenue);
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Use one context per unit of work and dispose it. Use `await using` for factory-created contexts.
- **MANDATORY**: In singletons and hosted services, inject `IDbContextFactory<T>` (or `IServiceScopeFactory` and create a scope per unit of work), never the context itself.
- **MANDATORY**: Await every EF async call before you start the next one on the same context.
- **DO NOT** inject a `DbContext` into a singleton or `BackgroundService` constructor, or keep one in a static field.
- **DO NOT** run `Task.WhenAll`, `Parallel.ForEachAsync` or `AsParallel()` over a single context instance.
- **DO NOT** register the context as a singleton. Use `ServiceLifetime.Transient` only when you have a specific reason.
- **DO NOT** keep mutable per-request fields on a pooled context unless you reset them every time. EF resets its own state, not your fields. If you open a `DbConnection` yourself, close it before the context goes back to the pool.
- **DO NOT** call `new ShopDbContext(...)` inside services that already use DI. That bypasses the configured options, pooling and logging.

## Version notes

- `AddDbContextPool` has been available since EF Core 2.0. `AddDbContextFactory`, `AddPooledDbContextFactory` and `IDbContextFactory<T>` arrived in **EF Core 5.0**. `IDbContextFactory<T>.CreateDbContextAsync` was added in **EF Core 6.0**. Before that, use `CreateDbContext()`.
- The default pool size is 1024 in current versions. EF Core 5.0 defaulted to 128.
- `ConfigureDbContext<T>` (for composing options across libraries and tests) and the `IDbContextOptionsConfiguration<T>` service it registers are **EF Core 9.0+**.
- EF Core 10 requires .NET 10. On EF Core 3.1 or earlier, use `IServiceScopeFactory.CreateScope()` in background services instead of a factory.

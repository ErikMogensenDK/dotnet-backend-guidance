---
name: testing-data-access
description: Test EF Core queries and API endpoints against the same database engine as production, with fast and isolated tests, instead of in-memory fakes.
keywords: [Testcontainers, Testcontainers.PostgreSql, Testcontainers.MsSql, PostgreSqlBuilder, WebApplicationFactory, Microsoft.AspNetCore.Mvc.Testing, ConfigureTestServices, IDbContextOptionsConfiguration, Respawn, Respawner, UseInMemoryDatabase, Microsoft.EntityFrameworkCore.InMemory, SQLite in-memory, IAsyncLifetime, ICollectionFixture]
---

# Testing Data Access

The EF Core InMemory provider (`UseInMemoryDatabase`) is **not a database**. It's not relational, it ignores transactions, it can't run raw SQL, it doesn't enforce constraints the way your database does, and it evaluates LINQ with .NET semantics (case-sensitive string comparison, no provider functions). Tests pass against it and the code fails in production. Microsoft explicitly discourages it for testing. Mocking `DbSet` has the same problems. Run data-access and endpoint tests against the **real engine** in a throwaway container (Testcontainers), apply your real migrations, and reset the data between tests.

## Implementation

1. Add `Testcontainers.PostgreSql` or `Testcontainers.MsSql`, `Microsoft.AspNetCore.Mvc.Testing`, and `Respawn` to the test project. Docker must be available locally and in CI.
2. Start one container per test collection (an xUnit `ICollectionFixture`). Container start-up costs seconds, while resetting data costs milliseconds. Pin the image tag to the version you run in production, and pass it to the builder constructor (`new PostgreSqlBuilder("postgres:17-alpine")`).
3. Build the schema with `Database.MigrateAsync()` so the tests also exercise your migrations. Don't use `EnsureCreatedAsync()` here.
4. For endpoint tests, subclass `WebApplicationFactory<Program>`. In `ConfigureTestServices`, remove the app's EF registration (`DbContextOptions<T>` **and**, on EF Core 9+, `IDbContextOptionsConfiguration<T>`) and re-add the context pointing at the container.
5. Reset state before each test. `Respawn` deletes rows in foreign-key order and skips `__EFMigrationsHistory`. When the test owns the context directly (no HTTP host), you can instead begin a transaction, run the test, and never commit, calling `ChangeTracker.Clear()` before asserting.
6. Assert through a **new** scope or context, not the one that wrote the data, so you read what the database stored rather than the change tracker's cached entities.
7. If you can't run Docker, SQLite in-memory is the least-bad fake. Keep one open `SqliteConnection` for the test's lifetime and create the schema with `EnsureCreated()`, because your production migrations target another provider. Expect differences: case-sensitive comparisons, no `rowversion`, no schemas, limited `ALTER TABLE`, and provider-specific functions that don't exist.

## Example Code

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Respawn;
using Testcontainers.PostgreSql;
using Xunit;

namespace Shop.Api.Tests;

// Assumes the API project exposes Program (top-level statements) and ShopDbContext with DbSet<Product> Products.
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();
    private Respawner _respawner = null!;

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<ShopDbContext>>();
            services.RemoveAll<IDbContextOptionsConfiguration<ShopDbContext>>();   // EF Core 9+
            services.AddDbContext<ShopDbContext>(o => o.UseNpgsql(_postgres.GetConnectionString()));
        });

    public async ValueTask InitializeAsync()
    {
        await _postgres.StartAsync();

        using (var scope = Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<ShopDbContext>().Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_postgres.GetConnectionString());
        await conn.OpenAsync();
        _respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
        {
            DbAdapter = DbAdapter.Postgres,
            SchemasToInclude = ["public"],
            TablesToIgnore = ["__EFMigrationsHistory"],
        });
    }

    public async Task ResetDatabaseAsync()
    {
        await using var conn = new NpgsqlConnection(_postgres.GetConnectionString());
        await conn.OpenAsync();
        await _respawner.ResetAsync(conn);
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _postgres.DisposeAsync();
    }
}

[CollectionDefinition(nameof(ApiCollection))]
public sealed class ApiCollection : ICollectionFixture<ApiFactory>;

[Collection(nameof(ApiCollection))]
public sealed class ProductEndpointTests(ApiFactory factory) : IAsyncLifetime
{
    public async ValueTask InitializeAsync() => await factory.ResetDatabaseAsync();
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Post_product_persists_it()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/products", new { Name = "Mug", Price = 9.50m }, ct);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        using var scope = factory.Services.CreateScope();          // fresh context: reads the database, not a cache
        var db = scope.ServiceProvider.GetRequiredService<ShopDbContext>();
        var saved = await db.Products.AsNoTracking().SingleAsync(p => p.Name == "Mug", ct);
        Assert.Equal(9.50m, saved.Price);
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Test queries, migrations, constraints, concurrency tokens and raw SQL against the same engine and major version as production.
- **MANDATORY**: Isolate tests. Reset data before each test (Respawn, or a rolled-back transaction) and never depend on test execution order.
- **MANDATORY**: Apply the real migrations in the test database. A test suite that runs `EnsureCreated` never exercises them.
- **DO NOT** use `UseInMemoryDatabase` (`Microsoft.EntityFrameworkCore.InMemory`) as a test database for application code.
- **DO NOT** mock `DbContext`/`DbSet` to test LINQ queries. To unit test business logic without a database, put the queries behind a small repository or query interface and stub that instead.
- **DO NOT** share one database between test collections that run in parallel. Use one container (or one database) per collection.
- **DO NOT** remove only `DbContextOptions<T>` in `WebApplicationFactory` on EF Core 9+. The app's original provider configuration lives on in `IDbContextOptionsConfiguration<T>`, and you'll end up with two providers registered.

## Version notes

- `IDbContextOptionsConfiguration<T>` (and `ConfigureDbContext<T>`): **EF Core 9.0+**. On EF Core 8 and earlier, removing `DbContextOptions<T>` is enough.
- **.NET 10** generates `public partial class Program` for top-level-statement apps, so `WebApplicationFactory<Program>` works without adding that declaration (analyzer ASP0027 flags the now-redundant manual one). On .NET 6–9, add `public partial class Program;` to the API project.
- Recent Testcontainers 4.x releases obsoleted the parameterless module builders (`new PostgreSqlBuilder().WithImage(...)`). Pass the image to the constructor. The example uses xUnit v3 (`ValueTask`-based `IAsyncLifetime`, `TestContext.Current`). xUnit v2 uses `Task InitializeAsync()`/`Task DisposeAsync()`.
- `Respawner.CreateAsync` (the async API with `RespawnerOptions`) is Respawn 6.0+. Older versions used a `Checkpoint` class.

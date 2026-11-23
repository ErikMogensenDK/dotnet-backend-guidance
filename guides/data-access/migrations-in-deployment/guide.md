---
name: migrations-in-deployment
description: Apply EF Core schema migrations safely in a CI/CD pipeline instead of from application startup, and review migrations before they reach production.
keywords: [dotnet ef migrations bundle, efbundle, dotnet ef migrations script --idempotent, Database.Migrate, MigrateAsync, EnsureCreated, has-pending-model-changes, HasPendingModelChanges, PendingModelChangesWarning, RenameColumn, migrationBuilder.Sql, Microsoft.EntityFrameworkCore.Design, dotnet-ef]
---

# Applying Migrations in Deployment

Calling `Database.Migrate()` or `MigrateAsync()` in `Program.cs` is the common shortcut. It gives the running app schema-change (DDL) permissions, applies SQL nobody reviewed, ties schema changes to whichever replica starts first, and turns a failed migration into a crash loop. `EnsureCreated()` is worse: it bypasses migrations entirely, so the database can never be migrated afterwards. Generate migrations at development time, review them like code, and apply them as a separate deployment step. Use a **migration bundle** for automated pipelines and an **idempotent SQL script** when a DBA or approval gate must read the SQL.

## Implementation

1. Install the tooling: add `Microsoft.EntityFrameworkCore.Design` to the startup project, and install `dotnet-ef` as a local tool (`dotnet new tool-manifest && dotnet tool install dotnet-ef`) so the CI version matches your EF version.
2. Add a migration with `dotnet ef migrations add AddOrderStatus`. **Read the generated `Up`/`Down` code.** When scaffolding prints *"An operation was scaffolded that may result in the loss of data"*, look for drops. A renamed property is scaffolded as `DropColumn` + `AddColumn`, so replace that with `RenameColumn`. When you split or merge columns, add the new column as nullable, backfill it with `migrationBuilder.Sql(...)`, then make it required and drop the old column.
3. In CI, fail the build if someone changed the model without adding a migration: `dotnet ef migrations has-pending-model-changes`, or a test using `db.Database.HasPendingModelChanges()`.
4. Build the deployment artifact in CI:
   - Bundle: `dotnet ef migrations bundle --self-contained --target-runtime linux-x64 --output artifacts/efbundle`
   - Script: `dotnet ef migrations script --idempotent --output artifacts/migrations.sql`. Idempotent scripts check `__EFMigrationsHistory` and apply only what's missing. SQLite doesn't support them.
5. Deploy: run `./efbundle --connection "$DEPLOY_CONNECTION_STRING"` (or apply the script) as a one-shot job **before** rolling out the new app version. Use a deployment identity with DDL rights. The app's runtime identity gets data permissions only. Set `ASPNETCORE_ENVIRONMENT` explicitly when building and running bundles.
6. Keep migrations backward-compatible with the version that's still running (expand, then contract). Add new columns or tables first, and drop old ones in a later release.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Migrations;
using Xunit;

namespace Shop.Data
{
    public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
    {
        public DbSet<Customer> Customers => Set<Customer>();
    }

    public sealed class Customer { public int Id { get; set; } public required string FullName { get; set; } }
}

namespace Shop.Data.Migrations
{
    // Reviewed migration: the scaffolder generated DropColumn("Name") + AddColumn("FullName"),
    // which would delete every customer's name. Replaced with a rename.
    public partial class RenameCustomerName : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder) =>
            migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");

        protected override void Down(MigrationBuilder migrationBuilder) =>
            migrationBuilder.RenameColumn(name: "FullName", table: "Customers", newName: "Name");
    }
}

namespace Shop.Data.Tests
{
    public sealed class MigrationTests
    {
        [Fact]
        public void Model_has_no_changes_missing_from_migrations()
        {
            // No database connection is opened; the model is compared with the migrations snapshot.
            var options = new DbContextOptionsBuilder<ShopDbContext>()
                .UseSqlServer("Server=unused;Database=unused")
                .Options;
            using var db = new ShopDbContext(options);

            Assert.False(db.Database.HasPendingModelChanges(),
                "Model changed without a migration. Run 'dotnet ef migrations add <Name>'.");
        }
    }
}
```

The `RenameCustomerName` class also needs its generated `[DbContext]`/`[Migration]` attributes from the `.Designer.cs` file. Keep the designer file the tooling created.

## Best Practices & Constraints

- **MANDATORY**: Review every generated migration, and its SQL (`dotnet ef migrations script <From> <To>`), before merging. Pay extra attention when scaffolding reports possible data loss.
- **MANDATORY**: Apply migrations in production with a bundle or a reviewed SQL script, as a dedicated pipeline step that runs once per deployment.
- **MANDATORY**: Commit the migration files and `ModelSnapshot` to source control. Never hand-edit the snapshot, and never delete a migration that has already been applied anywhere.
- **DO NOT** call `Database.Migrate()`/`MigrateAsync()` at startup in multi-instance or least-privilege production deployments. If a small single-instance app does it anyway, use EF Core 9+ (which takes a migration lock) and never wrap the call in your own transaction.
- **DO NOT** use `EnsureCreated()`/`EnsureCreatedAsync()` on any database you'll later migrate, and never call it before `Migrate()`. It's for throwaway test or prototype databases only.
- **DO NOT** suppress `RelationalEventId.PendingModelChangesWarning` to make `Migrate` stop throwing. Add the missing migration instead.
- **DO NOT** use your `DbContext` or entity classes inside a migration to move data. Old migrations must still compile and behave the same after those types change. Use `migrationBuilder.Sql`.
- **DO NOT** bake production connection strings into the bundle or `appsettings.json`. Pass them with `--connection` from the pipeline's secret store.

## Version notes

- Migration bundles (`dotnet ef migrations bundle`): **EF Core 6.0+**. On older versions, use idempotent scripts (`--idempotent`), which have been available since early EF Core versions.
- `has-pending-model-changes` and `HasPendingModelChanges()`: **EF Core 8.0+**.
- **EF Core 9.0**: `Migrate`, `MigrateAsync`, `database update` and bundles acquire a database-wide migration lock. `Migrate` throws on pending model changes, and calling it inside a user transaction throws `MigrationsUserTransactionWarning`. EF Core 9 applied all pending migrations in one transaction. **EF Core 10** reverted to one transaction per migration.
- **EF Core 10**: `dotnet ef` needs `--framework` for multi-targeted projects. Existing JSON `nvarchar(max)` columns are migrated to the `json` type when using `UseAzureSql` or compatibility level 170+. Review that migration.

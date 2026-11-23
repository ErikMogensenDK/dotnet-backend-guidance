---
name: raw-sql-safely
description: Run hand-written SQL through EF Core without SQL injection, and map the results to entities or plain DTOs.
keywords: [FromSql, FromSqlInterpolated, FromSqlRaw, ExecuteSql, ExecuteSqlAsync, ExecuteSqlRaw, ExecuteSqlInterpolated, SqlQuery, SqlQueryRaw, Database.SqlQuery, FormattableString, SqlParameter, NpgsqlParameter, SQL injection, keyless entity]
---

# Raw SQL Without SQL Injection

EF Core's SQL APIs come in two families. `FromSql`, `ExecuteSql` and `SqlQuery` (along with the older `*Interpolated` variants) take a `FormattableString`, so every `{value}` hole is sent as a **database parameter**. The `*Raw` methods take a plain `string`, so anything you concatenate or interpolate into it becomes executable SQL. The classic injection bug is `FromSqlRaw("... WHERE Name = '" + name + "'")`. Interpolating into a `string` variable and passing it to a `*Raw` method is the same bug. Use the interpolated APIs for values, allow-list identifiers you can't parameterize, and let EF compose LINQ on top of your SQL.

## Implementation

1. **Entities:** `db.Blogs.FromSql($"SELECT * FROM dbo.SearchBlogs({term})")`. The SQL must return every column the entity maps, using the mapped column names. `FromSql` only works directly on a `DbSet`.
2. **Compose:** add `.Where(...)`, `.OrderBy(...)`, `.Include(...)`, `.Select(...)` or `.AsNoTracking()` after `FromSql`. EF wraps your SQL as a subquery. That only works if the SQL is composable: it starts with `SELECT`, has no trailing `;`, and has no `ORDER BY` without `TOP`/`OFFSET`. Stored procedure calls can't be composed, so call `.AsAsyncEnumerable()` right after `FromSql` to stop EF from composing over them.
3. **Unmapped results (DTOs, scalars):** `db.Database.SqlQuery<T>($"...")` returns an `IQueryable<T>`. For scalars that you compose LINQ over, alias the column `AS [Value]` (`"Value"` on PostgreSQL).
4. **Commands:** `await db.Database.ExecuteSqlAsync($"UPDATE ... WHERE Id = {id}", ct)` returns the affected row count. This bypasses the change tracker, like `ExecuteUpdate`.
5. **Dynamic identifiers** (column or table names, sort direction) can't be parameters. Map user input to a fixed set of known identifiers with a `switch`, and only then use `FromSqlRaw`/`SqlQueryRaw`, passing values as `DbParameter`s (`SqlParameter`, `NpgsqlParameter`) or as positional `{0}` arguments.
6. To control parameter type, size or name explicitly, interpolate a `DbParameter` object: `FromSql($"EXEC dbo.Get @user={userParam}")`.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;

namespace Blogging.Search;

public sealed record BlogStats(int BlogId, string Url, int PostCount);

public sealed class BlogSqlQueries(BloggingContext db)
{
    // Parameterized: {term} and {minRating} become @p0/@p1; LINQ composes over the TVF result.
    public Task<List<Blog>> SearchAsync(string term, int minRating, CancellationToken ct) =>
        db.Blogs
            .FromSql($"SELECT * FROM dbo.SearchBlogs({term})")
            .Where(b => b.Rating >= minRating)
            .OrderByDescending(b => b.Rating)
            .AsNoTracking()
            .ToListAsync(ct);

    // Unmapped DTO: properties must match the result columns.
    public Task<List<BlogStats>> StatsAsync(DateOnly since, CancellationToken ct) =>
        db.Database.SqlQuery<BlogStats>($"""
            SELECT b.BlogId, b.Url, COUNT(p.PostId) AS PostCount
            FROM Blogs AS b LEFT JOIN Posts AS p ON p.BlogId = b.BlogId AND p.PublishedOn >= {since}
            GROUP BY b.BlogId, b.Url
            """).ToListAsync(ct);

    // Non-query command; returns rows affected.
    public Task<int> ArchiveAsync(int blogId, CancellationToken ct) =>
        db.Database.ExecuteSqlAsync($"UPDATE Blogs SET IsArchived = 1 WHERE BlogId = {blogId}", ct);

    // Dynamic ORDER BY: identifiers come only from an allow-list, values stay parameters.
    public Task<List<Blog>> ListAsync(string sortBy, int minRating, CancellationToken ct)
    {
        var column = sortBy switch
        {
            "url" => "[Url]",
            "rating" => "[Rating]",
            _ => "[BlogId]",
        };
        return db.Blogs
            .FromSqlRaw($"SELECT TOP 100 * FROM [Blogs] WHERE [Rating] >= {{0}} ORDER BY {column}", minRating)
            .AsNoTracking()
            .ToListAsync(ct);
    }
}

public sealed class BloggingContext(DbContextOptions<BloggingContext> options) : DbContext(options)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}

public sealed class Blog
{
    public int BlogId { get; set; }
    public required string Url { get; set; }
    public int Rating { get; set; }
    public bool IsArchived { get; set; }
}
```

The `ListAsync` call on `FromSqlRaw` uses `{{0}}` inside the C# interpolated string so that EF receives the literal `{0}` placeholder and sends `minRating` as a parameter. Only the allow-listed `column` is inlined.

## Best Practices & Constraints

- **MANDATORY**: Use `FromSql`, `SqlQuery` or `ExecuteSql` with inline `$"..."` interpolation for every value that comes from input, configuration or the database.
- **MANDATORY**: Pass identifiers you insert into `*Raw` SQL through an allow-list (`switch` or a fixed set of known names). Escaping or "sanitizing" by hand isn't enough.
- **MANDATORY**: Prefer LINQ. Use raw SQL for things LINQ can't express (TVFs, hints, CTEs, vendor features), and compose filters, paging and projections in LINQ on top.
- **DO NOT** call `FromSqlRaw`, `ExecuteSqlRaw` or `SqlQueryRaw` with string concatenation or `$"..."` that contains user values.
- **DO NOT** build the SQL in a `string` variable (`var sql = $"... {name}";`) and then pass it to any EF SQL method. Once it's a `string`, the parameterization is gone. Keep the interpolated string inline, or store it as a `FormattableString`.
- **DO NOT** quote placeholders (`'{name}'`). EF sends a typed parameter, and the quotes break the query.
- **DO NOT** use `SELECT *` in `SqlQuery<TDto>` against tables whose columns don't match the DTO. Every result column must map to a property.
- **DO NOT** drop down to ADO.NET `DbCommand` with concatenated SQL to work around EF. The same rules apply there.

## Version notes

- `FromSqlInterpolated`, `FromSqlRaw`, `ExecuteSqlInterpolated` and `ExecuteSqlRaw`: **EF Core 3.0+**. They replaced the ambiguous 2.x `FromSql(string)`/`ExecuteSqlCommand` overloads.
- `FromSql` (`FormattableString`), `ExecuteSql`/`ExecuteSqlAsync`, and `Database.SqlQuery<T>` for scalar types: **EF Core 7.0+**. On 3.x–6.x, use the `*Interpolated` methods.
- `SqlQuery<T>` for **unmapped** (non-scalar) types: **EF Core 8.0+**. Earlier, map a keyless entity type (`HasNoKey()`, `ToView(null)`) and use `FromSqlInterpolated`.
- **EF Core 10** ships an analyzer that warns when a `*Raw` SQL method receives concatenated strings. Treat the warning as an error unless the inserted fragment is allow-listed.

---
name: avoiding-n-plus-one-queries
description: Load related data in a fixed number of database round trips instead of one query per parent row, and spot N+1 problems in the SQL logs.
keywords: [N+1, Include, ThenInclude, filtered include, AsSplitQuery, AsSingleQuery, UseQuerySplittingBehavior, QuerySplittingBehavior.SplitQuery, cartesian explosion, UseLazyLoadingProxies, Microsoft.EntityFrameworkCore.Proxies, LogTo, ToQueryString, EnableSensitiveDataLogging, MultipleCollectionIncludeWarning]
---

# Avoiding N+1 Queries

An N+1 problem is one query for the parents followed by one more query per parent for its children. It usually comes from lazy-loading proxies, from calling `Entry(x).Collection(...).LoadAsync()` or running a query inside a `foreach`, or from a JSON serializer walking lazy navigations. Each extra round trip is cheap on its own, but they add up fast. The fix is to state up front what to load: project the related data in `Select`, or use `Include`/`ThenInclude`. When you load several collections at once, choose deliberately between a single JOIN query (which risks a cartesian explosion) and split queries.

## Implementation

1. **Prefer projection.** `Select(b => new BlogDto(b.Name, b.Posts.Select(p => p.Title).ToList()))` loads exactly the columns you need in one statement, with no `Include` required.
2. **When you need entities**, eager-load them with `Include(b => b.Posts).ThenInclude(p => p.Author)`. To load a second branch under the same collection, repeat the `Include(b => b.Posts)` path.
3. **Filtered include** limits the loaded children: `Include(b => b.Posts.Where(p => p.Published).OrderByDescending(p => p.Date).Take(5))`. Supported operators are `Where`, `OrderBy(Descending)`, `ThenBy(Descending)`, `Skip` and `Take`. Combine it with `AsNoTracking()`. In a tracking query, entities that are already tracked are fixed up into the navigation even if they don't match the filter.
4. **Two or more collection includes at the same level** multiply rows: blogs × posts × contributors. Add `AsSplitQuery()` so EF runs one SQL statement per collection, or set `UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery)` globally and opt out with `AsSingleQuery()`. Split queries cost extra round trips and are not a consistent snapshot unless you wrap them in a snapshot or serializable transaction.
5. **Replace loops of queries** with one set-based query: `Where(c => ids.Contains(c.Id))`, then use `ToDictionaryAsync` for in-memory lookups.
6. **Make queries visible.** In development, log SQL with `LogTo(Console.WriteLine, LogLevel.Information)` or by setting the `Microsoft.EntityFrameworkCore.Database.Command` log category to `Information`. Inspect a single query with `query.ToQueryString()`. The same SQL repeated with different parameter values is the N+1 signature.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Blogging;

public sealed record BlogDto(int Id, string Name, List<string> RecentPostTitles, int ContributorCount);

public sealed class BlogQueries(BloggingContext db)
{
    // Projection: one round trip, only needed columns, no tracking, no Include.
    public Task<List<BlogDto>> GetBlogsAsync(CancellationToken ct) =>
        db.Blogs
            .OrderBy(b => b.Id)
            .Select(b => new BlogDto(
                b.Id,
                b.Name,
                b.Posts.OrderByDescending(p => p.PublishedOn).Take(3).Select(p => p.Title).ToList(),
                b.Contributors.Count))
            .ToListAsync(ct);

    // Entities with two collections: split to avoid blogs × posts × contributors rows.
    public Task<List<Blog>> GetBlogGraphsAsync(CancellationToken ct) =>
        db.Blogs
            .AsNoTracking()
            .Include(b => b.Posts.Where(p => p.PublishedOn != null))
                .ThenInclude(p => p.Author)
            .Include(b => b.Contributors)
            .AsSplitQuery()
            .OrderBy(b => b.Id)
            .ToListAsync(ct);
}

public sealed class BloggingContext(DbContextOptions<BloggingContext> options) : DbContext(options)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}

public static class BloggingRegistration
{
    public static IServiceCollection AddBlogging(this IServiceCollection services, string cs, bool isDevelopment) =>
        services.AddDbContext<BloggingContext>(o =>
        {
            o.UseSqlServer(cs);
            // Fail fast in development when a query loads multiple collections without choosing a strategy.
            o.ConfigureWarnings(w => w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
            if (isDevelopment)
                o.LogTo(Console.WriteLine, LogLevel.Information).EnableSensitiveDataLogging();
        });
}

public sealed class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Post> Posts { get; } = [];
    public List<Person> Contributors { get; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public DateTimeOffset? PublishedOn { get; set; }
    public Person Author { get; set; } = null!;
}

public sealed class Person { public int Id { get; set; } public required string Name { get; set; } }
```

## Best Practices & Constraints

- **MANDATORY**: Decide what each query loads at the call site, either with a projection or with explicit `Include`.
- **MANDATORY**: When you use `AsSplitQuery()` with `Skip`/`Take`, order by a unique key (for example `OrderBy(x => x.Date).ThenBy(x => x.Id)`).
- **MANDATORY**: Turn `EnableSensitiveDataLogging()` on only in development. It writes parameter values, which may include PII, to the logs.
- **DO NOT** enable `UseLazyLoadingProxies()` (package `Microsoft.EntityFrameworkCore.Proxies`) in web APIs. Every navigation access in a loop, a mapper or a serializer becomes a hidden query, and touching a navigation after the context is disposed throws.
- **DO NOT** return entities with navigations straight from endpoints. Serializers traverse the graph, triggering lazy loads or hitting cycles. Return DTOs.
- **DO NOT** call `LoadAsync`, `FindAsync` or `FirstOrDefaultAsync` inside a `foreach` over query results. Batch with `Contains` instead.
- **DO NOT** chain several collection `Include`s in a single query without measuring. Check the row count the JOIN produces, or use `AsSplitQuery()`.
- **DO NOT** expect a navigation to be loaded just because it's empty or `null`. Without lazy loading, EF populates only what you included or projected.

## Version notes

- Filtered include, `AsSplitQuery`/`AsSingleQuery`, `UseQuerySplittingBehavior`, `ToQueryString()` and `LogTo` are all **EF Core 5.0+**. On EF Core 3.x, every query was a single query. Project instead, or issue separate queries yourself.
- EF Core 2.x split collection includes automatically. EF Core 3.0 switched to single queries, which is why upgraded apps can suddenly hit cartesian explosion.
- **EF Core 10** makes split-query ordering consistent across the generated statements. Before EF Core 10, always add a unique tiebreaker to `OrderBy` when using split queries with `Take`/`Skip`.
- **EF Core 10** translates `ids.Contains(...)` to multiple scalar parameters (EF Core 8–9 used a JSON array parameter). It redacts inlined constants in logs unless sensitive data logging is enabled.

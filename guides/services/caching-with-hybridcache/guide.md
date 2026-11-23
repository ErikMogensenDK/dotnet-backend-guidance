---
name: caching-with-hybridcache
description: Cache expensive data reads across one or many app instances with stampede protection, tag-based invalidation and an optional Redis second level.
keywords: [HybridCache, AddHybridCache, GetOrCreateAsync, SetAsync, RemoveAsync, RemoveByTagAsync, HybridCacheEntryOptions, HybridCacheOptions, LocalCacheExpiration, ImmutableObject, IMemoryCache, IDistributedCache, AddStackExchangeRedisCache, cache stampede, Microsoft.Extensions.Caching.Hybrid]
---

# Cache Data with HybridCache

Hand-written cache-aside code (`TryGetValue` → query → `Set`) on `IMemoryCache` or `IDistributedCache` has no stampede protection: when a hot key expires, every concurrent request runs the query. `IDistributedCache` also makes you serialize `byte[]` yourself and can't invalidate groups of entries. `HybridCache` combines an in-process L1 cache with an optional distributed L2, collapses concurrent misses for a key into one factory call, serializes for you, and supports tags.

## Implementation

1. **Add `Microsoft.Extensions.Caching.Hybrid` and call `services.AddHybridCache(o => ...)`.** Set `DefaultEntryOptions` there. The other limits are `MaximumPayloadBytes` (1 MB by default) and `MaximumKeyLength` (1024), and entries over either limit are logged and not cached.
2. **For an L2 cache, register an out-of-process `IDistributedCache`**, for example `AddStackExchangeRedisCache`. `HybridCache` uses it automatically, but ignores `AddDistributedMemoryCache`.
3. **Read with `GetOrCreateAsync(key, factory, options, tags, ct)`.** The factory's token is canceled only when *all* waiting callers cancel. On hot paths, use the overload with a `state` argument and a `static` lambda.
4. **Build keys from trusted IDs with a delimiter, written inline** (`$"product:{id}"`). Never use raw user input.
5. **Invalidate after writes:** `RemoveAsync(key)`, or `RemoveByTagAsync(tag)` for a group. `RemoveByTagAsync("*")` invalidates everything.
6. **Mark cached DTOs `sealed` and `[ImmutableObject(true)]`** so L1 hits return the same instance instead of deserializing a new one each time.
7. **With several instances, keep `LocalCacheExpiration` shorter than `Expiration`.** Invalidation clears L1 only on the node that performs it.

## Example Code

```csharp
using System.ComponentModel;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.DependencyInjection;

namespace Shop.Catalog;

[ImmutableObject(true)] // with 'sealed', lets HybridCache reuse instances instead of deserializing copies
public sealed record ProductDto(int Id, string Name, decimal Price, int CategoryId);

public interface IProductRepository
{
    Task<ProductDto?> FindAsync(int id, CancellationToken ct);
    Task UpdatePriceAsync(int id, decimal price, CancellationToken ct);
}

public sealed class ProductCatalog(HybridCache cache, IProductRepository repository)
{
    private static readonly HybridCacheEntryOptions ProductEntry = new()
    {
        Expiration = TimeSpan.FromMinutes(30),         // L2 (and L1 unless overridden)
        LocalCacheExpiration = TimeSpan.FromMinutes(2), // bounds cross-node staleness
    };

    public ValueTask<ProductDto?> GetAsync(int id, CancellationToken ct) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            (repository, id),
            static async (state, token) => await state.repository.FindAsync(state.id, token),
            ProductEntry,
            tags: ["products"],
            cancellationToken: ct);

    public async Task UpdatePriceAsync(int id, decimal price, CancellationToken ct)
    {
        await repository.UpdatePriceAsync(id, price, ct);
        await cache.RemoveAsync($"product:{id}", ct); // write first, then invalidate
    }

    public ValueTask InvalidateAllProductsAsync(CancellationToken ct) =>
        cache.RemoveByTagAsync("products", ct);
}

public static class CachingRegistration
{
    public static IServiceCollection AddCatalogCaching(this IServiceCollection services, string? redisConnection)
    {
        if (redisConnection is not null)
        {
            services.AddStackExchangeRedisCache(o => o.Configuration = redisConnection); // optional L2
        }

        services.AddHybridCache(o =>
        {
            o.DefaultEntryOptions = new HybridCacheEntryOptions
            {
                Expiration = TimeSpan.FromMinutes(5),
                LocalCacheExpiration = TimeSpan.FromMinutes(1),
            };
        });
        return services;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Invalidate after every successful write that changes cached data.
- **MANDATORY**: Cached types must serialize with `System.Text.Json`, or you register `.AddSerializer<T, TSerializer>()` or `.AddSerializerFactory<TFactory>()`. For Native AOT, use JSON source generation.
- **DO NOT** hand-write `TryGetValue`/`Set` cache-aside code for expensive shared data.
- **DO NOT** mutate cached objects. Mutable types give each caller a copy, so your changes are lost. Immutable-marked instances are shared across requests.
- **DO NOT** treat `RemoveByTagAsync` as freeing memory. Tag invalidation is logical: entries become misses but stay stored until they expire.
- **DO NOT** use glob tags (`"foo*"`), or empty or whitespace tags. `*` is reserved.
- Keep `IMemoryCache` for sliding expiration, size limits, eviction callbacks, objects that can't be serialized (`Regex`, delegates, connections), and small single-instance caches. Use `IDistributedCache` directly only when other systems read the raw bytes.
- Use output caching (`AddOutputCache`) for whole HTTP responses and `HybridCache` for data.

## Version notes

- The abstract `HybridCache` class is in `Microsoft.Extensions.Caching.Abstractions` 9.0+. The implementation (`AddHybridCache`) is in the `Microsoft.Extensions.Caching.Hybrid` package, which became GA as 9.3.0 in March 2025.
- The package targets .NET 8+, .NET Standard 2.0 and .NET Framework, so it works in .NET 8 apps. It's versioned with the .NET Extensions releases, so use the latest version.
- L2 reads without `byte[]` allocations (`IBufferDistributedCache`) depend on your provider package version (Redis, SQL Server, Postgres).
- Without the package, use `IMemoryCache.GetOrCreateAsync` plus a per-key `SemaphoreSlim` for stampede protection, or a third-party implementation of the `HybridCache` abstraction.

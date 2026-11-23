---
name: resilient-http-calls
description: Call external HTTP APIs reliably, retrying transient failures with timeouts and circuit breakers, without exhausting sockets or missing DNS changes.
keywords: [IHttpClientFactory, AddHttpClient, typed client, AddStandardResilienceHandler, HttpStandardResilienceOptions, DisableForUnsafeHttpMethods, AddStandardHedgingHandler, AddResilienceHandler, RemoveAllResilienceHandlers, ConfigureHttpClientDefaults, Microsoft.Extensions.Http.Resilience, Polly, SocketsHttpHandler, PooledConnectionLifetime, socket exhaustion]
---

# Make Resilient Outgoing HTTP Calls

`new HttpClient()` per request exhausts sockets: each instance owns a connection pool and leaves sockets in `TIME_WAIT`. A `static HttpClient` with default settings never picks up DNS changes. Hand-written retry loops, and Polly v7 policies added with `AddPolicyHandler`, usually lack per-attempt timeouts and jitter, and they retry non-idempotent POSTs. Use `IHttpClientFactory` with typed clients and the standard pipeline from `Microsoft.Extensions.Http.Resilience`, which is built on Polly v8.

## Implementation

1. **Write a typed client:** a class that takes `HttpClient` in its constructor and exposes domain methods. Register it with `services.AddHttpClient<TClient>(c => c.BaseAddress = ...)`. Don't also register `TClient` yourself, because that overrides the factory registration.
2. **Add `.AddStandardResilienceHandler()`.** From outermost to innermost, it chains:
   - rate limiter: 1000 permits
   - total timeout: 30 s
   - retry: 3 attempts, exponential backoff with jitter from 2 s; retries 5xx, 408, 429 and `HttpRequestException`
   - circuit breaker: 10% failures, minimum throughput 100, 30 s sampling, 5 s break
   - attempt timeout: 10 s
3. **Tune it with `AddStandardResilienceHandler(o => ...)`.** Keep `CircuitBreaker.SamplingDuration` ≥ 2 × `AttemptTimeout.Timeout` and `TotalRequestTimeout` > `AttemptTimeout`. Otherwise `OptionsValidationException` is thrown when the client is created.
4. **Don't retry non-idempotent calls.** Use `o.Retry.DisableForUnsafeHttpMethods()` (POST, PUT, PATCH, DELETE, CONNECT) or `DisableFor(HttpMethod.Post)`, unless the API supports idempotency keys.
5. **To apply resilience to all clients,** use `services.ConfigureHttpClientDefaults(b => b.AddStandardResilienceHandler())`. Opt a client out with `.RemoveAllResilienceHandlers()`. Build custom pipelines with `AddResilienceHandler("name", b => ...)` instead of stacking handlers.
6. **Without DI,** use one long-lived `HttpClient` over `new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) }`.

## Example Code

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience; // DisableForUnsafeHttpMethods extension

namespace Shop.Catalog;

public sealed record ProductDto(int Id, string Name, decimal Price);

public sealed class CatalogClient(HttpClient http)
{
    public async Task<ProductDto?> GetProductAsync(int id, CancellationToken ct)
    {
        using HttpResponseMessage response = await http.GetAsync($"products/{id}", ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ProductDto>(ct);
    }

    public async Task ReserveAsync(int id, int quantity, CancellationToken ct)
    {
        // POST: not retried (see DisableForUnsafeHttpMethods below)
        using HttpResponseMessage response =
            await http.PostAsJsonAsync($"products/{id}/reservations", new { quantity }, ct);
        response.EnsureSuccessStatusCode();
    }
}

public static class CatalogRegistration
{
    public static IServiceCollection AddCatalogClient(this IServiceCollection services, Uri baseAddress)
    {
        services.AddHttpClient<CatalogClient>(client =>
            {
                client.BaseAddress = baseAddress; // must end with '/', e.g. https://catalog/api/
            })
            .AddStandardResilienceHandler(options =>
            {
                options.Retry.DisableForUnsafeHttpMethods();
                options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(5);
                options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(20);
                options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(30); // >= 2x attempt timeout
            });

        return services;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Get every `HttpClient` from `IHttpClientFactory` (typed client or `CreateClient(name)`), or use a long-lived instance with `PooledConnectionLifetime`.
- **MANDATORY**: Pass the caller's `CancellationToken`. Handle `TimeoutRejectedException` and `BrokenCircuitException` (open circuit) as degraded responses, not 500s.
- **DO NOT** create `new HttpClient()` per call or wrap it in `using`.
- **DO NOT** keep a `static readonly HttpClient` built on the default handler in a long-running service. It pins DNS.
- **DO NOT** default to Polly v7 `AddPolicyHandler`/`AddTransientHttpErrorPolicy` (`Microsoft.Extensions.Http.Polly`) or hand-written retry loops in new code.
- **DO NOT** stack resilience handlers, for example a global default plus a per-client one. Call `RemoveAllResilienceHandlers()` first.
- **DO NOT** inject typed clients (they're transient) into singletons, because that defeats handler rotation. In singletons, use `IHttpClientFactory.CreateClient` per operation, or set `PooledConnectionLifetime` with `UseSocketsHttpHandler`.
- **DO NOT** derive client names from unbounded input. Each name gets its own handler pool.
- `HttpClient.Timeout` (100 s) wraps the whole pipeline. Keep it above `TotalRequestTimeout`.
- A `BaseAddress` without a trailing slash drops its last segment: `https://x/api` + `products/1` → `https://x/products/1`.
- Register Application Insights before `AddStandardResilienceHandler`. Otherwise its dependency tracking breaks, which is a known issue.

## Version notes

- `IHttpClientFactory`: .NET Core 2.1+. `UseSocketsHttpHandler`: .NET 5+. `ConfigureHttpClientDefaults`: .NET 8+.
- `Microsoft.Extensions.Http.Resilience` first shipped as 8.0 alongside .NET 8. It also targets `netstandard2.0`, so older apps can reference it. .NET Framework assets exist but aren't officially supported.
- `RemoveAllResilienceHandlers` and `DisableForUnsafeHttpMethods`/`DisableFor` were added in later package versions. If they're missing, update the package, or filter methods with `options.Retry.ShouldHandle`.
- Apps that still use `Microsoft.Extensions.Http.Polly` should migrate. Don't combine both packages' handlers on one client.

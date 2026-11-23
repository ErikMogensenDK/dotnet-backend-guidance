---
name: rate-limiting
description: Limit how many requests a client, user or IP address can make to an ASP.NET Core API and return 429 Too Many Requests when they exceed it.
keywords: [AddRateLimiter, UseRateLimiter, RequireRateLimiting, DisableRateLimiting, EnableRateLimiting, Microsoft.AspNetCore.RateLimiting, System.Threading.RateLimiting, RateLimiterOptions, RejectionStatusCode, OnRejected, AddFixedWindowLimiter, AddSlidingWindowLimiter, AddTokenBucketLimiter, AddConcurrencyLimiter, RateLimitPartition, PartitionedRateLimiter, GlobalLimiter, MetadataName.RetryAfter, 429 Too Many Requests, Retry-After]
---

# Rate Limit API Endpoints

Hand-rolled throttling (a static `ConcurrentDictionary` of counters, `MemoryCache` hit counts, or the old `AspNetCoreRateLimit` package) is racy, leaks memory, and usually ignores queuing and `Retry-After`. ASP.NET Core has built-in rate limiting middleware with fixed window, sliding window, token bucket and concurrency algorithms, partitioning per user/key/IP, and per-endpoint policies. Its default rejection status is `503`, which is wrong for client throttling. Set it to `429`.

## Implementation

1. Call `builder.Services.AddRateLimiter(options => ...)` and set `options.RejectionStatusCode = StatusCodes.Status429TooManyRequests`.
2. Choose the algorithm for each policy:
   - **Fixed window**: N requests per window. Simple, but allows bursts at window edges.
   - **Sliding window**: a window split into `SegmentsPerWindow`. Smoother than fixed.
   - **Token bucket**: allows bursts up to `TokenLimit`, refilled at `TokensPerPeriod`. Good default for public APIs.
   - **Concurrency**: limits requests *in flight*, not per time. Use it to protect expensive endpoints (reports, exports).
3. Partition limits per caller with `options.AddPolicy(name, httpContext => RateLimitPartition.GetXxxLimiter(partitionKey, _ => options))`: authenticated user ID first, then API key, then client IP. The plain `AddFixedWindowLimiter("name", ...)` helpers create **one shared limiter for all callers**.
4. Use `options.GlobalLimiter` (a `PartitionedRateLimiter.Create<HttpContext, string>(...)`) for a coarse per-IP ceiling on every request. It runs in addition to endpoint policies.
5. Attach policies with `.RequireRateLimiting("policy")` on groups or endpoints (`[EnableRateLimiting("policy")]` on controllers) and opt out with `.DisableRateLimiting()`.
6. In `OnRejected`, copy `MetadataName.RetryAfter` to the `Retry-After` header and write a problem details body.
7. Call `app.UseRateLimiter()` **after** `UseRouting` (if called explicitly) and after `UseAuthentication`, so endpoint policies and `HttpContext.User` are available.
8. Behind a reverse proxy or load balancer, configure `UseForwardedHeaders` with known proxies first. Otherwise `RemoteIpAddress` is the proxy and every client shares one bucket.

## Example Code

```csharp
using System.Globalization;
using System.Security.Claims;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddAuthentication().AddJwtBearer();
builder.Services.AddAuthorization();

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // Per caller: user id when authenticated, otherwise client IP.
    options.AddPolicy("per-caller", httpContext =>
    {
        var userId = httpContext.User.FindFirstValue("sub");
        return userId is not null
            ? RateLimitPartition.GetTokenBucketLimiter($"user:{userId}", _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = 100,
                TokensPerPeriod = 50,
                ReplenishmentPeriod = TimeSpan.FromSeconds(10),
                QueueLimit = 0
            })
            : RateLimitPartition.GetFixedWindowLimiter($"ip:{httpContext.Connection.RemoteIpAddress}", _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 20,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            });
    });

    // At most 4 concurrent exports per user; a short queue smooths spikes.
    options.AddPolicy("exports", httpContext =>
        RateLimitPartition.GetConcurrencyLimiter(httpContext.User.FindFirstValue("sub") ?? "anonymous", _ => new ConcurrencyLimiterOptions
        {
            PermitLimit = 4,
            QueueLimit = 2,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst
        }));

    options.OnRejected = async (context, cancellationToken) =>
    {
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter =
                ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(NumberFormatInfo.InvariantInfo);
        }

        var problemDetails = context.HttpContext.RequestServices.GetRequiredService<IProblemDetailsService>();
        await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context.HttpContext,
            ProblemDetails = { Title = "Too many requests", Detail = "Rate limit exceeded. Retry later." }
        });
    };
});

var app = builder.Build();

app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();        // after authentication so policies can partition by user

var api = app.MapGroup("/api").RequireRateLimiting("per-caller");
api.MapGet("/orders", () => TypedResults.Ok(Array.Empty<string>()));
api.MapPost("/exports", async (CancellationToken ct) =>
{
    await Task.Delay(TimeSpan.FromSeconds(2), ct);
    return TypedResults.Accepted("/api/exports/1");
}).RequireRateLimiting("exports");  // both the group policy and this policy apply

app.MapGet("/health", () => "ok").DisableRateLimiting();

app.Run();
```

## Best Practices & Constraints

- **MANDATORY**: Set `RejectionStatusCode = 429`. The default `503 Service Unavailable` tells clients and load balancers the server is down.
- **MANDATORY**: Partition by a stable, server-validated identity: user ID from the validated token, an API key you have looked up, or `RemoteIpAddress` after forwarded headers are configured. Each distinct key creates a cached limiter, so never partition on raw client-controlled input (an unvalidated header or query value). That lets attackers bypass limits or exhaust memory.
- **MANDATORY**: Exempt health check and readiness endpoints (`.DisableRateLimiting()`) so orchestrators don't restart healthy instances.
- **DO NOT** write custom counter middleware with `ConcurrentDictionary`/`IMemoryCache`, or add `AspNetCoreRateLimit` to new .NET 7+ projects.
- **DO NOT** use `AddFixedWindowLimiter("x", ...)` and assume it is per client. It is a single global bucket for every endpoint that uses the policy.
- **DO NOT** set large `QueueLimit` values on time-based limiters for APIs. Queued requests hold connections and inflate latency. Prefer `QueueLimit = 0` and fast `429`s. Queues fit concurrency limiters for short spikes.
- **DO NOT** treat this middleware as distributed rate limiting. Limits are per process instance. For limits across instances, enforce them at the API gateway (Azure API Management, YARP with a shared store, NGINX, Envoy) or use a distributed limiter.
- `ConcurrencyLimiter` doesn't provide `RetryAfter` metadata. Only send `Retry-After` when the lease has it.

## Version notes

- Built-in rate limiting (`Microsoft.AspNetCore.RateLimiting`, `System.Threading.RateLimiting`): .NET 7. It ships in the shared framework, so no package is needed. On .NET 6 and earlier, use a gateway or the `AspNetCoreRateLimit` package.

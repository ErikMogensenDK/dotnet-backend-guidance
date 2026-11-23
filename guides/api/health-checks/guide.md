---
name: health-checks
description: Expose separate liveness and readiness health endpoints for an ASP.NET Core API that check databases and dependencies without leaking internal details.
keywords: [AddHealthChecks, MapHealthChecks, IHealthCheck, HealthCheckResult, HealthCheckOptions, Predicate, HealthStatus, AddCheck, AddDbContextCheck, Microsoft.Extensions.Diagnostics.HealthChecks, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore, AspNetCore.HealthChecks.NpgSql, AspNetCore.HealthChecks.UI.Client, ResponseWriter, liveness probe, readiness probe, Kubernetes]
---

# Expose Liveness and Readiness Health Checks

Typical hand-written health endpoints are a `GET /health` that always returns `"OK"`, or a single endpoint that queries every dependency. With the second, a slow database makes Kubernetes *restart* every healthy pod (a liveness failure) when it should only stop sending them traffic (a readiness failure). They often also serialize exception messages, connection strings and versions to anonymous callers. Use the built-in health checks middleware with tags: a dependency-free **liveness** endpoint, a **readiness** endpoint that checks the database and critical dependencies, and detailed output only for authorized callers or internal ports.

## Implementation

1. Call `builder.Services.AddHealthChecks()` and register checks with tags. Tag a trivial self-check `"live"`. Tag database and critical downstream checks `"ready"`.
2. For databases, use `AddDbContextCheck<TContext>()` (package `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`; it calls `Database.CanConnectAsync`) or a provider check from the community `AspNetCore.HealthChecks.*` packages (`AddNpgSql`, `AddSqlServer`, `AddRedis`, …).
3. Write custom checks as `IHealthCheck` classes. Return `Healthy`, `Degraded` (works, but impaired) or `Unhealthy`, honor the `CancellationToken`, and set a short `timeout:` when registering.
4. Map separate endpoints filtered by tag: `MapHealthChecks("/health/live", new() { Predicate = r => r.Tags.Contains("live") })` and `"/health/ready"` with `"ready"`. Point the orchestrator's liveness, readiness and startup probes at them.
5. The default response is plain text (`Healthy`/`Degraded`/`Unhealthy`) with `200` for Healthy/Degraded and `503` for Unhealthy. Keep that for public or anonymous probes.
6. For a detailed JSON report (per-check status and duration), map a separate endpoint with a custom `ResponseWriter` and restrict it with `.RequireAuthorization(...)` or `.RequireHost("*:8081")` (an internal management port).
7. Exclude probe endpoints from the auth fallback policy (`.AllowAnonymous()`), rate limiting (`.DisableRateLimiting()`), and request timeouts if needed. Use `.DisableHttpMetrics()` to keep probe traffic out of HTTP metrics.

## Example Code

```csharp
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(builder.Configuration.GetConnectionString("app")));
builder.Services.AddHttpClient<PaymentsHealthCheck>(c => c.BaseAddress = new Uri("https://payments.internal"));

builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"])
    .AddCheck<PaymentsHealthCheck>("payments-api", failureStatus: HealthStatus.Degraded,
        tags: ["ready"], timeout: TimeSpan.FromSeconds(3));

builder.Services.AddAuthorization();

var app = builder.Build();

// Public probes: status text only, no dependency details.
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = r => r.Tags.Contains("live") })
   .AllowAnonymous().DisableHttpMetrics();
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = r => r.Tags.Contains("ready") })
   .AllowAnonymous().DisableHttpMetrics();

// Detailed report: management port only.
app.MapHealthChecks("/health/details", new HealthCheckOptions { ResponseWriter = WriteJsonReport })
   .RequireHost("*:8081");

app.Run();

static Task WriteJsonReport(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json";
    return context.Response.WriteAsync(JsonSerializer.Serialize(new
    {
        status = report.Status.ToString(),
        durationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            durationMs = e.Value.Duration.TotalMilliseconds,
            description = e.Value.Description // never the exception or connection string
        })
    }));
}

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options);

public sealed class PaymentsHealthCheck(HttpClient http) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await http.GetAsync("/health/live", cancellationToken);
            return response.IsSuccessStatusCode
                ? HealthCheckResult.Healthy()
                : new HealthCheckResult(context.Registration.FailureStatus, $"Payments returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return new HealthCheckResult(context.Registration.FailureStatus, "Payments unreachable.", ex);
        }
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Liveness must not check external dependencies. It answers "is this process able to serve at all?" A database outage should fail readiness, not trigger restarts of every instance.
- **MANDATORY**: Give every dependency check a timeout shorter than the probe timeout, and pass the `CancellationToken` through. A hanging check makes the whole endpoint hang.
- **MANDATORY**: Anonymous health endpoints return only the overall status. Exception messages, stack traces, connection strings, hostnames and versions go only to authorized callers or internal ports.
- **DO NOT** write a custom `app.MapGet("/health", () => "OK")` that checks nothing, or one that queries every dependency inline.
- **DO NOT** publish the `AspNetCore.HealthChecks.UI.Client` `UIResponseWriter.WriteHealthCheckUIResponse` JSON on a public endpoint. It includes exception messages and check data.
- **DO NOT** mark non-critical dependencies (a recommendations service, a cache with a fallback) as `Unhealthy` for readiness. Register them with `failureStatus: HealthStatus.Degraded` so the instance keeps receiving traffic.
- **DO NOT** run expensive queries in checks. Probes run every few seconds per instance. Use `CanConnectAsync`/`SELECT 1`-style checks, and cache results in the check if the dependency is costly to call.
- Each health check run resolves checks from a new DI scope, so a check registered with `AddCheck<T>` can inject scoped services such as a `DbContext` directly.

## Version notes

- Health checks middleware, tags, `Predicate`, `AddDbContextCheck`: available since ASP.NET Core 2.2. The `MapHealthChecks` endpoint-routing form: 3.0. Everything in the example except `DisableHttpMetrics` works on every supported .NET version.
- `.DisableHttpMetrics()`: .NET 9. On .NET 8, leave it out.
- .NET Aspire `ServiceDefaults` maps `/health` (all checks) and `/alive` (`"live"` tag) and, by default, only in Development, which is a reminder to secure health endpoints before exposing them in production.
- `AspNetCore.HealthChecks.*` (Xabaril) packages are community-maintained and versioned separately from .NET. Check that the package version supports your target framework.

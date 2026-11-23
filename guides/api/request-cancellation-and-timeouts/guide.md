---
name: request-cancellation-and-timeouts
description: Stop server work when an API client disconnects and cap how long a request may run by passing cancellation tokens and configuring request timeouts.
keywords: [CancellationToken, HttpContext.RequestAborted, OperationCanceledException, TaskCanceledException, AddRequestTimeouts, UseRequestTimeouts, WithRequestTimeout, RequestTimeout attribute, DisableRequestTimeout, RequestTimeoutPolicy, RequestTimeoutOptions, IHttpRequestTimeoutFeature, Microsoft.AspNetCore.Http.Timeouts, 499 Client Closed Request, 504 Gateway Timeout]
---

# Cancel Abandoned Requests and Enforce Request Timeouts

Generated handlers routinely drop the `CancellationToken`. They call `ToListAsync()`, `HttpClient.GetAsync(url)` or `Task.Delay(...)` without it, so the server keeps querying the database and calling downstream services after the client has disconnected or timed out. Others wrap work in `Task.Run` or a hand-made `CancellationTokenSource` timer. In ASP.NET Core the request's token (`HttpContext.RequestAborted`) is cancelled when the client disconnects **or** when the request timeouts middleware fires. Bind it, pass it to every async call, and configure timeouts declaratively.

## Implementation

1. Add a `CancellationToken` parameter to every async handler. Minimal APIs and controller actions bind it to `HttpContext.RequestAborted` automatically, so no attribute is needed.
2. Pass the token to every async API that accepts one: EF Core (`ToListAsync(ct)`, `SaveChangesAsync(ct)`), `HttpClient` calls, `Stream.ReadAsync`, `Channel` reads, `Task.Delay`, and your own service methods (`Task<T> GetAsync(..., CancellationToken ct)`).
3. Register `builder.Services.AddRequestTimeouts(...)` with a `DefaultPolicy` for the whole API and named policies for slower endpoints. Add `app.UseRequestTimeouts()` after `UseRouting` (if called explicitly).
4. Apply per-endpoint limits with `.WithRequestTimeout(TimeSpan)` / `.WithRequestTimeout("policy")` (or `[RequestTimeout(...)]` on controllers), and `.DisableRequestTimeout()` for streaming, SSE and long-polling endpoints.
5. Let `OperationCanceledException` propagate. When the timeout fires and the handler throws, the middleware writes the policy's `TimeoutStatusCode` (default `504`). When the client disconnects, the exception handler middleware logs it at debug level and sets `499` without running error handlers.
6. For work that must finish once started (charging a card, writing an outbox message after the main commit), don't pass the request token to that final step. Use `CancellationToken.None`, or hand the work to a background queue (`Channel<T>` + `BackgroundService`) that has its own lifetime token.
7. Keep downstream timeouts (HttpClient resilience handler, database command timeout) shorter than the request timeout so failures surface as meaningful errors.

## Example Code

```csharp
using Microsoft.AspNetCore.Http.Timeouts;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddHttpClient<InventoryClient>(c => c.BaseAddress = new Uri("https://inventory.example.com"));
builder.Services.AddRequestTimeouts(options =>
{
    options.DefaultPolicy = new RequestTimeoutPolicy { Timeout = TimeSpan.FromSeconds(10) };
    options.AddPolicy("reports", new RequestTimeoutPolicy
    {
        Timeout = TimeSpan.FromSeconds(60),
        TimeoutStatusCode = StatusCodes.Status503ServiceUnavailable
    });
});

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseRequestTimeouts();

// The CancellationToken is HttpContext.RequestAborted: cancelled on disconnect or timeout.
app.MapGet("/api/products/{id:int}/stock", async (int id, InventoryClient inventory, CancellationToken ct) =>
    TypedResults.Ok(await inventory.GetStockAsync(id, ct)));

app.MapGet("/api/reports/sales", async (CancellationToken ct) =>
{
    await Task.Delay(TimeSpan.FromSeconds(30), ct); // stands in for a long query that honors ct
    return TypedResults.Ok(new { total = 1234.5m });
}).WithRequestTimeout("reports");

app.MapGet("/api/events", async (HttpResponse response, CancellationToken ct) =>
{
    response.ContentType = "text/event-stream";
    while (!ct.IsCancellationRequested)
    {
        await response.WriteAsync($"data: {DateTimeOffset.UtcNow:O}\n\n", ct);
        await response.Body.FlushAsync(ct);
        await Task.Delay(TimeSpan.FromSeconds(1), ct);
    }
}).DisableRequestTimeout(); // long-lived stream: no default timeout

app.Run();

public sealed class InventoryClient(HttpClient http)
{
    public async Task<StockLevel> GetStockAsync(int productId, CancellationToken ct) =>
        await http.GetFromJsonAsync<StockLevel>($"/stock/{productId}", ct)
            ?? throw new InvalidOperationException("Empty inventory response.");
}

public record StockLevel(int ProductId, int Available);
```

## Best Practices & Constraints

- **MANDATORY**: Accept a `CancellationToken` in every async handler and pass it through every layer down to I/O. A token that stops at the service layer protects nothing.
- **MANDATORY**: Put `CancellationToken ct` (conventionally last, `= default` only on public library APIs) on your own async interfaces so callers can pass it down.
- **MANDATORY**: Exempt streaming, SSE, WebSocket and long-polling endpoints from the default timeout with `.DisableRequestTimeout()`.
- **DO NOT** catch `OperationCanceledException` (or `catch (Exception)`) and log it as an error or turn it into a `500`. Rethrow it, or filter it out with `catch (Exception ex) when (ex is not OperationCanceledException)`.
- **DO NOT** implement timeouts with `new CancellationTokenSource(TimeSpan)` + `Task.WhenAny` in each handler, or with `Task.Run(...).Wait(timeout)`. Use the request timeouts middleware, plus `CancellationTokenSource.CreateLinkedTokenSource(ct)` + `CancelAfter` only for a sub-operation that needs a tighter budget.
- **DO NOT** start fire-and-forget work (`_ = Task.Run(...)`) that captures `HttpContext`, scoped services or the request token. They are disposed or cancelled when the request ends. Queue the work to a hosted service instead.
- **DO NOT** expect timeouts to fire while debugging. The middleware doesn't trigger with a debugger attached (same as Kestrel timeouts). Test without the debugger.
- **DO NOT** rely on the timeout middleware to abort code that ignores the token. Timeouts are cooperative: the middleware only cancels `RequestAborted` and doesn't call `HttpContext.Abort()`.

## Version notes

- Request timeouts middleware (`AddRequestTimeouts`, `UseRequestTimeouts`, `WithRequestTimeout`, `[RequestTimeout]`, `DisableRequestTimeout`, `IHttpRequestTimeoutFeature`): .NET 8. On .NET 7 and earlier, create a linked `CancellationTokenSource` with `CancelAfter` in an endpoint filter or middleware and replace `HttpContext.RequestAborted` with its token.
- Automatic `CancellationToken` binding to `RequestAborted` exists in all ASP.NET Core versions (controllers) and in Minimal APIs since .NET 6.
- The exception handler middleware's `499` handling for aborted requests (no error log, no error handlers): .NET 8.
- `TypedResults.ServerSentEvents` (.NET 10) is a higher-level option than the manual `text/event-stream` loop above. It still needs `.DisableRequestTimeout()` when a default policy is set.

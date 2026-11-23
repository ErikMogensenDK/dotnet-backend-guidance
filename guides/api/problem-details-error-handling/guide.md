---
name: problem-details-error-handling
description: Return consistent RFC 9457 problem details JSON for exceptions and error status codes from an ASP.NET Core API without leaking stack traces.
keywords: [AddProblemDetails, IExceptionHandler, AddExceptionHandler, UseExceptionHandler, UseStatusCodePages, IProblemDetailsService, ProblemDetailsContext, ProblemDetails, CustomizeProblemDetails, ExceptionHandlerOptions, StatusCodeSelector, SuppressDiagnosticsCallback, RFC 9457, RFC 7807, application/problem+json]
---

# Return Problem Details for API Errors

APIs often return a mix of HTML error pages, raw `500` strings, empty `404` bodies and ad-hoc `{ "error": "..." }` objects, usually produced by a `try/catch` copied into every endpoint. Clients then need special parsing for each failure, and `ex.ToString()` responses leak stack traces and internals. ASP.NET Core has built-in problem details support (RFC 9457, which replaces RFC 7807): register it once, handle exceptions centrally with `IExceptionHandler`, and every error response gets the same `application/problem+json` shape.

## Implementation

1. Call `builder.Services.AddProblemDetails()`. This registers `IProblemDetailsService`. Use `CustomizeProblemDetails` only for app-wide extensions; `traceId` is already added by default.
2. Add `app.UseExceptionHandler()` (no arguments) as the **first** middleware, then `app.UseStatusCodePages()`. With `AddProblemDetails`, the exception handler writes a generic `500` problem response, and status code pages fills empty `4xx`/`5xx` bodies (for example routing `404`s, bare `TypedResults.NotFound()`) with problem details.
3. Map known exception types to status codes in an `IExceptionHandler` registered with `AddExceptionHandler<T>()`. Handlers are singletons and run in registration order. Return `false` for exceptions you don't recognize so the default `500` response runs.
4. When a handler returns `true`, it must set `Response.StatusCode` and write the body, usually via `IProblemDetailsService.TryWriteAsync`. If it writes nothing, the client gets a `404`.
5. For a simple exception-type-to-status mapping, `ExceptionHandlerOptions.StatusCodeSelector` (.NET 9+) is enough without a custom handler.
6. For expected failures (not found, validation, conflict), return `TypedResults.NotFound()`, `TypedResults.Problem(...)` or `TypedResults.ValidationProblem(...)` from the endpoint. Throwing exceptions should be the exception, not the normal control flow.
7. Log inside your handler. In .NET 10, the middleware no longer logs exceptions that an `IExceptionHandler` handled (`TryHandleAsync` returned `true`).

## Example Code

```csharp
using Microsoft.AspNetCore.Diagnostics;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = ctx =>
        ctx.ProblemDetails.Instance ??= ctx.HttpContext.Request.Path);
builder.Services.AddExceptionHandler<DomainExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // generic 500 problem details; never exposes exception details
app.UseStatusCodePages();    // problem details for empty 4xx/5xx responses

app.MapGet("/orders/{id:int}", (int id) => id switch
{
    0 => throw new InvalidOperationException("Connection string 'db' leaked?"), // -> 500, message not exposed
    < 0 => throw new NotFoundException($"Order {id} was not found."),           // -> 404 via handler
    _ => Results.Ok(new { id })
});

app.Run();

public sealed class NotFoundException(string message) : Exception(message);
public sealed class ConflictException(string message) : Exception(message);

internal sealed class DomainExceptionHandler(
    IProblemDetailsService problemDetailsService,
    ILogger<DomainExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        (int Status, string Title)? mapped = exception switch
        {
            NotFoundException => (StatusCodes.Status404NotFound, "Resource not found"),
            ConflictException => (StatusCodes.Status409Conflict, "Conflict"),
            _ => null
        };
        if (mapped is not { } m)
        {
            return false; // unknown exception: fall back to the default 500 problem details
        }

        logger.LogWarning(exception, "Request failed with {StatusCode}", m.Status);

        httpContext.Response.StatusCode = m.Status;
        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails =
            {
                Status = m.Status,
                Title = m.Title,
                Detail = exception.Message // safe only because these are our own domain exceptions
            }
        });
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Call `AddProblemDetails()` before `app.UseExceptionHandler()` with no arguments. Without problem details (or an error path or handler lambda), the parameterless overload throws `InvalidOperationException` at startup.
- **MANDATORY**: Register `UseExceptionHandler()` before all other middleware so it catches exceptions from the whole pipeline.
- **MANDATORY**: Only expose `exception.Message` for exception types you own and know are safe. Unknown exceptions must produce the generic `500` problem details. Never put `ex.ToString()`, `ex.StackTrace` or inner exception messages in a production response.
- **DO NOT** wrap every endpoint body in `try { ... } catch (Exception ex) { return Results.Problem(ex.Message); }` or return raw strings such as `Results.StatusCode(500)` with `"Something went wrong"`. Let exceptions reach the central handler.
- **DO NOT** write custom exception-handling middleware (`app.Use(async (ctx, next) => { try { await next(ctx); } catch ... })`) or use the old `Hellang.Middleware.ProblemDetails` package on .NET 8+. `IExceptionHandler` + `AddProblemDetails` is the built-in replacement.
- **DO NOT** call `app.UseDeveloperExceptionPage()` yourself. `WebApplication` already enables it in Development, where it returns problem details with the stack trace to non-HTML clients. Never enable it in other environments.
- **DO NOT** treat client disconnects as errors. The exception handler middleware already turns an `OperationCanceledException` from an aborted request into status `499` and skips the error handlers.
- **DO NOT** return `200 OK` with an error payload. Use the right `4xx`/`5xx` status code with problem details.
- Controllers with `[ApiController]` already turn error results into `ProblemDetails`. Add the same `AddProblemDetails` + `UseExceptionHandler` + `UseStatusCodePages` setup so exceptions and routing errors match.

## Version notes

- `AddProblemDetails`/`IProblemDetailsService` and problem details from `UseExceptionHandler`/`UseStatusCodePages`/developer exception page: .NET 7.
- `IExceptionHandler` and `AddExceptionHandler<T>`: .NET 8. On .NET 7, use `UseExceptionHandler(errorApp => errorApp.Run(...))` and write through `IProblemDetailsService`.
- `ExceptionHandlerOptions.StatusCodeSelector`: .NET 9.
- .NET 10: handled exceptions are no longer logged by the middleware by default. Set `ExceptionHandlerOptions.SuppressDiagnosticsCallback = _ => false` to restore the old logging.
- With `RouteHandlerOptions.ThrowOnBadRequest = true`, binding failures throw `BadHttpRequestException`. On .NET 10 and earlier, `UseExceptionHandler` reports them as `500` unless your handler copies `BadHttpRequestException.StatusCode` into the response. .NET 11 keeps the original status code by default.

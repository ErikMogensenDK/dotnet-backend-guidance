---
name: expected-failures-result-pattern
description: Decide when to throw exceptions and when to return a result for expected business failures, and map those failures to HTTP problem responses at the API boundary.
keywords: [Result pattern, Result<T>, Error, exceptions for control flow, TypedResults, Results union return type, ProblemHttpResult, TypedResults.Problem, ValidationProblem, ProblemDetails, AddProblemDetails, IExceptionHandler, UseExceptionHandler, domain errors]
---

# Return Results for Expected Failures, Throw for Exceptional Ones

Throwing `NotFoundException`/`ValidationException` for routine outcomes and mapping them to status codes in a global filter hides control flow, captures a stack trace on every bad request, and keeps the failure modes out of method signatures. Wrapping *everything*, outages included, in result objects is the opposite mistake: it hides bugs and forces manual checks in every layer. The deciding question is whether the caller can reasonably act on the failure.

## Implementation

1. **Classify each failure:**
   - *Expected business outcomes* ("not found", "insufficient stock", "already registered", "invalid state transition") are return values.
   - *Programmer errors and broken invariants* are exceptions: `ArgumentNullException.ThrowIfNull`, `InvalidOperationException`.
   - *Infrastructure failures* (database down, timeouts) are exceptions that propagate.
2. **Model expected failures** as a small `Result<T>` plus an `Error` record (`Code`, `Message`, `Kind`). It can be hand-rolled or come from a library; use one style per codebase. Keep errors in static factories (`OrderErrors.NotFound(id)`) so codes stay stable.
3. **Return `Result<T>` from services whose operations can fail on business rules.** For queries where "may not exist" is the only failure, `T?` is enough.
4. **Map results to HTTP in one place at the API boundary** as RFC 9457 Problem Details: `NotFound` → 404, `Conflict` → 409, `Validation` → 400/422 (`TypedResults.ValidationProblem`), anything unknown → 500. A `Results<Ok<T>, ProblemHttpResult>` return type keeps OpenAPI metadata accurate.
5. **Let unexpected exceptions reach the global handler:** `AddProblemDetails()` + `UseExceptionHandler()`, optionally with an `IExceptionHandler`. Clients get a generic 500 without internals.

## Example Code

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

namespace Shop.Orders;

public enum ErrorKind { Validation, NotFound, Conflict }

public sealed record Error(string Code, string Message, ErrorKind Kind);

public sealed class Result<T>
{
    private Result(T? value, Error? error) => (Value, Error) = (value, error);

    public T? Value { get; }
    public Error? Error { get; }
    public bool IsSuccess => Error is null;

    public static implicit operator Result<T>(T value) => new(value, null);
    public static implicit operator Result<T>(Error error) => new(default, error);
}

public static class OrderErrors
{
    public static Error NotFound(Guid id) => new("order.not_found", $"Order {id} was not found.", ErrorKind.NotFound);
    public static Error AlreadyShipped(Guid id) => new("order.already_shipped", $"Order {id} has already shipped.", ErrorKind.Conflict);
}

public sealed record OrderDto(Guid Id, string Status);

public sealed class Order(Guid id)
{
    public Guid Id { get; } = id;
    public string Status { get; set; } = "Placed";
}

public interface IOrderRepository
{
    Task<Order?> FindAsync(Guid id, CancellationToken ct); // throws if the database is unreachable
    Task SaveAsync(Order order, CancellationToken ct);
}

public sealed class OrderService(IOrderRepository orders)
{
    public async Task<Result<OrderDto>> CancelAsync(Guid id, CancellationToken ct)
    {
        Order? order = await orders.FindAsync(id, ct);
        if (order is null) return OrderErrors.NotFound(id);
        if (order.Status == "Shipped") return OrderErrors.AlreadyShipped(id);

        order.Status = "Cancelled";
        await orders.SaveAsync(order, ct);
        return new OrderDto(order.Id, order.Status);
    }
}

public static class OrderEndpoints
{
    public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/orders/{id:guid}/cancel",
            async Task<Results<Ok<OrderDto>, ProblemHttpResult>> (Guid id, OrderService service, CancellationToken ct) =>
            {
                Result<OrderDto> result = await service.CancelAsync(id, ct);
                return result.IsSuccess ? TypedResults.Ok(result.Value) : result.Error!.ToProblem();
            });
        return app;
    }

    // The single place where domain errors become HTTP.
    public static ProblemHttpResult ToProblem(this Error error) => TypedResults.Problem(
        title: error.Code,
        detail: error.Message,
        statusCode: error.Kind switch
        {
            ErrorKind.NotFound => StatusCodes.Status404NotFound,
            ErrorKind.Conflict => StatusCodes.Status409Conflict,
            ErrorKind.Validation => StatusCodes.Status400BadRequest,
            _ => StatusCodes.Status500InternalServerError,
        });
}
```

## Best Practices & Constraints

- **MANDATORY**: Map results to HTTP only at the boundary. Services and domain code never reference `IResult`, status codes or `ProblemDetails`.
- **MANDATORY**: Register `AddProblemDetails()` and `UseExceptionHandler()` so exceptions that escape still produce a consistent 500 Problem Details with no stack trace.
- **DO NOT** use exceptions for control flow, such as throwing `NotFoundException` to get a 404 or using `try/catch` to test business rules.
- **DO NOT** catch `Exception` in services and convert it to a failed result. Bugs and outages must stay exceptions so they're logged, traced and returned as 500.
- **DO NOT** return results for invariant violations or from constructors. Throw, because the caller has a bug.
- **DO NOT** ignore a returned result. Branch on `IsSuccess` or propagate it.
- **DO NOT** leak exception messages, SQL or internal IDs in `detail`. Give clients stable error `Code`s to switch on.
- When a library reports an expected condition as an exception, translate it at the narrowest point. For example, EF Core's `DbUpdateConcurrencyException` becomes a `Conflict` error.
- Return all field errors at once, mapped with `TypedResults.ValidationProblem(IDictionary<string, string[]>)`.

## Version notes

- `TypedResults`, `Results<T1, ...>`, `ProblemHttpResult` and `AddProblemDetails()`: .NET 7+. On .NET 6, use `Results.Problem(...)` or `ObjectResult` with `ProblemDetails`.
- `IExceptionHandler` (`AddExceptionHandler<T>()`): .NET 8+. Earlier versions use `UseExceptionHandler` with a lambda that reads `IExceptionHandlerFeature`.
- `ArgumentNullException.ThrowIfNull`: .NET 6+. `ArgumentOutOfRangeException.ThrowIfNegative` and `ArgumentException.ThrowIfNullOrWhiteSpace`: .NET 8+.
- RFC 9457 obsoletes RFC 7807, and the Problem Details JSON shape is unchanged.

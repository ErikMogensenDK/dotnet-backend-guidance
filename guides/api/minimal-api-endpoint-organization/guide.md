---
name: minimal-api-endpoint-organization
description: Organize ASP.NET Core API endpoints into feature route groups with strongly typed results instead of one long Program.cs.
keywords: [MapGroup, RouteGroupBuilder, TypedResults, Results, IEndpointRouteBuilder, AsParameters, Microsoft.AspNetCore.Http.HttpResults, Ok<T>, NotFound, CreatedAtRoute, WithTags, WithName, ControllerBase, ApiController]
---

# Organize Minimal API Endpoints with Route Groups and Typed Results

Minimal APIs scale badly when every `app.MapGet(...)` lives in `Program.cs` with an inline lambda that returns `IResult` or `Results.Ok(...)`. Untyped `IResult` hides the possible responses from the compiler, from tests and from OpenAPI, and repeating the route prefix, auth and filters on every endpoint invites drift. Group each feature's endpoints with `MapGroup`, put them in an extension method per feature, and return `TypedResults` with a `Results<...>` union so the handler's signature *is* the response contract.

## Implementation

1. Create one static class per feature (`OrderEndpoints`, `CustomerEndpoints`) with a `Map<Feature>Endpoints(this IEndpointRouteBuilder routes)` extension method. `Program.cs` only calls `app.MapOrderEndpoints();`.
2. Inside it, call `routes.MapGroup("/api/orders")` once and apply shared conventions to the group: `.WithTags(...)`, `.RequireAuthorization(...)`, `.AddEndpointFilter(...)`, `.RequireRateLimiting(...)`. Groups can be nested; conventions are inherited.
3. Write handlers as `static` methods (not long lambdas) so they are unit-testable and readable. Inject services, route values, `CancellationToken` and the body as parameters; use `[AsParameters]` to bind a record when a handler needs many parameters.
4. Return `TypedResults.X(...)` and declare the return type: a single outcome is `Ok<T>`/`Created<T>`/`NoContent`; several outcomes are `Results<Ok<T>, NotFound>` (up to six types). Make it `async Task<Results<...>>` for async handlers.
5. Name endpoints that other endpoints link to (`.WithName("GetOrder")`) and use `TypedResults.CreatedAtRoute(...)` for `201 Created` with a `Location` header.
6. If the team already uses controllers (`[ApiController]` + `ControllerBase` + `ActionResult<T>`), keep them. Controllers are fully supported; do not rewrite a working controller codebase just to switch styles. Pick one style per resource.

## Example Code

```csharp
using Microsoft.AspNetCore.Http.HttpResults;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddSingleton<IOrderStore, InMemoryOrderStore>();

var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages();

app.MapOrderEndpoints();

app.Run();

// In a real project each type below lives in its own file with a file-scoped namespace.
public static class OrderEndpoints
{
    public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder routes)
    {
        var orders = routes.MapGroup("/api/orders").WithTags("Orders");

        orders.MapGet("/", ListOrders);
        orders.MapGet("/{id:guid}", GetOrder).WithName("GetOrder");
        orders.MapPost("/", CreateOrder);
        orders.MapDelete("/{id:guid}", DeleteOrder);

        return routes;
    }

    static async Task<Ok<IReadOnlyList<OrderDto>>> ListOrders(IOrderStore store, CancellationToken ct) =>
        TypedResults.Ok(await store.ListAsync(ct));

    static async Task<Results<Ok<OrderDto>, NotFound>> GetOrder(Guid id, IOrderStore store, CancellationToken ct) =>
        await store.FindAsync(id, ct) is { } order ? TypedResults.Ok(order) : TypedResults.NotFound();

    static async Task<CreatedAtRoute<OrderDto>> CreateOrder(CreateOrderRequest request, IOrderStore store, CancellationToken ct)
    {
        var order = await store.AddAsync(request.Customer, request.Total, ct);
        return TypedResults.CreatedAtRoute(order, "GetOrder", new { id = order.Id });
    }

    static async Task<Results<NoContent, NotFound>> DeleteOrder(Guid id, IOrderStore store, CancellationToken ct) =>
        await store.RemoveAsync(id, ct) ? TypedResults.NoContent() : TypedResults.NotFound();
}

public record OrderDto(Guid Id, string Customer, decimal Total);
public record CreateOrderRequest(string Customer, decimal Total);

public interface IOrderStore
{
    Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken ct);
    Task<OrderDto?> FindAsync(Guid id, CancellationToken ct);
    Task<OrderDto> AddAsync(string customer, decimal total, CancellationToken ct);
    Task<bool> RemoveAsync(Guid id, CancellationToken ct);
}

public sealed class InMemoryOrderStore : IOrderStore
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, OrderDto> _orders = new();
    public Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<OrderDto>>([.. _orders.Values]);
    public Task<OrderDto?> FindAsync(Guid id, CancellationToken ct) => Task.FromResult(_orders.GetValueOrDefault(id));
    public Task<OrderDto> AddAsync(string customer, decimal total, CancellationToken ct)
    {
        var order = new OrderDto(Guid.CreateVersion7(), customer, total);
        return Task.FromResult(_orders[order.Id] = order);
    }
    public Task<bool> RemoveAsync(Guid id, CancellationToken ct) => Task.FromResult(_orders.TryRemove(id, out _));
}
```

## Best Practices & Constraints

- **MANDATORY**: Use `TypedResults`, not `Results`, inside a `Results<...>` union. `Results.Ok(x)` returns `IResult` and will not convert to `Results<Ok<T>, NotFound>`; the typed result types live in `Microsoft.AspNetCore.Http.HttpResults`.
- **MANDATORY**: Give lambdas or methods with more than one result type an explicit return type (`async Task<Results<Ok<T>, NotFound>> (...) => ...`). Without it, the compiler can't infer a common type for the branches.
- **MANDATORY**: Apply cross-cutting conventions (auth, tags, filters, rate limiting) on the `RouteGroupBuilder`, not repeated per endpoint.
- **DO NOT** return `IResult`, `object` or an anonymous type from API handlers. You lose compile-time checking, `IEndpointMetadataProvider` response metadata for OpenAPI, and typed assertions in unit tests (`Assert.IsType<Ok<OrderDto>>(result.Result)`).
- **DO NOT** keep all endpoints as inline lambdas in `Program.cs`, and don't use reflection-based "auto-register every `IEndpoint`" scanning libraries unless the team has chosen one. Explicit `MapXxxEndpoints()` calls are AOT-friendly and easy to find.
- **DO NOT** resolve services from `HttpContext.RequestServices` or `IServiceProvider` inside handlers. Declare them as handler parameters.
- **DO NOT** return EF Core entities directly. Return DTO records so the API contract doesn't change when the schema does.
- **DO NOT** mix controllers and Minimal APIs for the same resource or route prefix. Mixing them across features during a migration is fine.

## Version notes

- `MapGroup`/`RouteGroupBuilder`, `TypedResults`, `Results<T1,...,T6>`, `[AsParameters]` and endpoint filters were added in .NET 7. On .NET 6, use controllers or per-endpoint mapping with `Results`.
- Automatic OpenAPI response metadata from `TypedResults` return types (via `IEndpointMetadataProvider`) works from .NET 7. Built-in OpenAPI document generation needs .NET 9+ (see the openapi-documentation guide).
- .NET 10: endpoints that return `TypedResults` or read/write JSON are marked with `IApiEndpointMetadata`, so cookie authentication returns `401`/`403` instead of redirecting to a login page.
- `Guid.CreateVersion7()` (time-ordered IDs, used in the example) needs .NET 9+.

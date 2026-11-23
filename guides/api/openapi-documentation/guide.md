---
name: openapi-documentation
description: Generate an accurate OpenAPI document for an ASP.NET Core API and optionally serve an interactive API reference UI.
keywords: [Microsoft.AspNetCore.OpenApi, AddOpenApi, MapOpenApi, IOpenApiDocumentTransformer, AddDocumentTransformer, AddOperationTransformer, AddSchemaTransformer, AddOpenApiOperationTransformer, WithName, WithSummary, WithDescription, WithTags, Produces, ProducesProblem, ProducesValidationProblem, ExcludeFromDescription, Scalar.AspNetCore, MapScalarApiReference, Swashbuckle, OpenApiSecurityScheme, Microsoft.OpenApi]
---

# Generate OpenAPI Documents with Microsoft.AspNetCore.OpenApi

Models still scaffold `AddSwaggerGen()`/`UseSwagger()`/`UseSwaggerUI()` from Swashbuckle. Since .NET 9 the `webapi` template doesn't include Swashbuckle. ASP.NET Core generates OpenAPI documents itself with `Microsoft.AspNetCore.OpenApi` (`AddOpenApi`/`MapOpenApi`), using transformers instead of Swashbuckle filters. In .NET 10 it emits OpenAPI 3.1 by default. The quality of the document depends on endpoint metadata: typed results, names, summaries and problem responses.

## Implementation

1. Add the `Microsoft.AspNetCore.OpenApi` package (the `webapi` template already includes it). Call `builder.Services.AddOpenApi()` and `app.MapOpenApi()`. The document is served at `/openapi/v1.json`. Pass a name (`AddOpenApi("internal")`) for more documents and assign endpoints with `.WithGroupName("internal")`.
2. Describe endpoints with metadata: `.WithName()` (becomes the `operationId`; use it for client generation), `.WithSummary()`, `.WithDescription()`, `.WithTags()`. Request and response schemas come from parameter types and `TypedResults`/`Results<...>` return types automatically.
3. Add `.Produces<T>(status)`, `.ProducesProblem(status)` or `.ProducesValidationProblem()` only for responses the signature can't express, such as errors from middleware/exception handlers or handlers returning `IResult`. Hide internal endpoints with `.ExcludeFromDescription()`.
4. Change document-wide data (info, servers, security schemes) with a document transformer: `options.AddDocumentTransformer(...)` or a class implementing `IOpenApiDocumentTransformer` (resolved from DI, so it can inject services). Use operation and schema transformers for per-operation and per-type changes, and `.AddOpenApiOperationTransformer(...)` for a single endpoint.
5. Optionally enable `<GenerateDocumentationFile>true</GenerateDocumentationFile>` in the project file. In .NET 10, XML `/// <summary>` comments on handler methods and types are added to the document.
6. Choose a UI separately. `Scalar.AspNetCore` (`app.MapScalarApiReference()`, served at `/scalar`) or Swashbuckle's standalone `Swashbuckle.AspNetCore.SwaggerUI` pointed at `/openapi/v1.json` both work. Map the document and UI only in Development unless the API is public.
7. To generate the document at build time (for client generation or CI diffing), add `Microsoft.Extensions.ApiDescription.Server`. The document is generated on every `dotnet build`.

## Example Code

```csharp
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddAuthentication().AddJwtBearer();
builder.Services.AddAuthorization();
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo { Title = "Orders API", Version = "v1", Description = "Order management." };
        return Task.CompletedTask;
    });
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();               // GET /openapi/v1.json
    app.MapScalarApiReference();    // GET /scalar (optional UI)
}

var orders = app.MapGroup("/api/orders").WithTags("Orders").RequireAuthorization();

orders.MapGet("/{id:guid}", async Task<Results<Ok<OrderDto>, NotFound>> (Guid id, CancellationToken ct) =>
    {
        await Task.Yield();
        return id == Guid.Empty ? TypedResults.NotFound() : TypedResults.Ok(new OrderDto(id, 42m));
    })
    .WithName("GetOrder")
    .WithSummary("Get an order by id")
    .WithDescription("Returns 404 when the order does not exist.");

orders.MapPost("/", (CreateOrderRequest request) =>
        TypedResults.Created($"/api/orders/{Guid.Empty}", new OrderDto(Guid.Empty, request.Total)))
    .WithName("CreateOrder")
    .WithSummary("Create an order")
    .ProducesValidationProblem()                                  // written by validation, not the signature
    .ProducesProblem(StatusCodes.Status500InternalServerError);  // written by the exception handler

app.MapGet("/internal/cache-stats", () => "ok").ExcludeFromDescription();

app.Run();

public record OrderDto(Guid Id, decimal Total);
public record CreateOrderRequest(decimal Total);

internal sealed class BearerSecuritySchemeTransformer(IAuthenticationSchemeProvider schemes) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        if (!(await schemes.GetAllSchemesAsync()).Any(s => s.Name == "Bearer"))
        {
            return;
        }

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes = new Dictionary<string, IOpenApiSecurityScheme>
        {
            ["Bearer"] = new OpenApiSecurityScheme { Type = SecuritySchemeType.Http, Scheme = "bearer", BearerFormat = "JWT" }
        };

        foreach (var operation in document.Paths.Values.SelectMany(path => path.Operations ?? []))
        {
            operation.Value.Security ??= [];
            operation.Value.Security.Add(new OpenApiSecurityRequirement
            {
                [new OpenApiSecuritySchemeReference("Bearer", document)] = []
            });
        }
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Give every public endpoint a unique `.WithName(...)`. Generated clients (Kiota, NSwag, OpenAPI Generator) use the `operationId` as the method name.
- **MANDATORY**: Return `TypedResults`/`Results<...>` so response types and status codes are documented without repeating them in `.Produces(...)`.
- **MANDATORY**: In .NET 10 transformers, use the OpenAPI.NET 2.x API: `using Microsoft.OpenApi;` (not `Microsoft.OpenApi.Models`), interfaces like `IOpenApiSchema`/`IOpenApiSecurityScheme`, `OpenApiSecuritySchemeReference`/`OpenApiSchemaReference` instead of `Reference = new OpenApiReference { ... }`, `JsonNode` instead of `OpenApiAny`, and `JsonSchemaType.Null` in `schema.Type` instead of `Nullable`.
- **DO NOT** add Swashbuckle (`AddSwaggerGen`, `UseSwagger`, `ISchemaFilter`, `IOperationFilter`) to a new .NET 9+ project just to get a document. If you only want the Swagger UI, use `Swashbuckle.AspNetCore.SwaggerUI` with `c.SwaggerEndpoint("/openapi/v1.json", "v1")`.
- **DO NOT** call `.WithOpenApi()`. It is deprecated in .NET 10 (`ASPDEPR002`). Use `WithSummary`/`WithDescription` or `AddOpenApiOperationTransformer`.
- **DO NOT** expose the document or UI in production by default. If needed, protect them with `app.MapOpenApi().RequireAuthorization(...)` or restrict them by environment.
- Note: in OpenAPI 3.1 output, `int`/`long` appear as `type: [integer, string]` with a digits `pattern`, because System.Text.Json accepts numbers as strings by default (`JsonSerializerDefaults.Web`). Set `JsonSerializerOptions.NumberHandling = JsonNumberHandling.Strict` via `ConfigureHttpJsonOptions` if you want plain `integer`.

## Version notes

- `AddOpenApi`/`MapOpenApi` and document/operation/schema transformers: .NET 9 (`Microsoft.AspNetCore.OpenApi` 9.x, OpenAPI 3.0 output). The .NET 9 templates removed Swashbuckle.
- .NET 10 (`Microsoft.AspNetCore.OpenApi` 10.x): OpenAPI 3.1 by default (set `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0` for 3.0 consumers), Microsoft.OpenApi 2.x breaking changes in transformers, YAML output (`app.MapOpenApi("/openapi/{documentName}.yaml")`), XML doc comment support, `AddOpenApiOperationTransformer`, `IOpenApiDocumentProvider` in DI, and `WithOpenApi` deprecated.
- .NET 8 and earlier: `Microsoft.AspNetCore.OpenApi` only provides `WithOpenApi()` metadata, not document generation. Use Swashbuckle.AspNetCore or NSwag there, and plan to move to the built-in generator when upgrading.
- `Scalar.AspNetCore` is a third-party package (current major 3.x). Check its README for option names, which have changed between majors.

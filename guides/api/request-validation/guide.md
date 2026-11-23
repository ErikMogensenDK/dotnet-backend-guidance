---
name: request-validation
description: Validate incoming API request bodies, query strings and headers and reject invalid input with a 400 validation problem response.
keywords: [AddValidation, Microsoft.Extensions.Validation, DisableValidation, ValidatableType, SkipValidation, DataAnnotations, Required, Range, StringLength, IValidatableObject, ValidationAttribute, TypedResults.ValidationProblem, HttpValidationProblemDetails, IEndpointFilter, AddEndpointFilter, FluentValidation, ApiController, UnmappedMemberHandling]
---

# Validate API Requests

Before .NET 10, Minimal APIs did no validation at all. Data Annotations on a request record were silently ignored, so handlers started with hand-written `if` chains or `Validator.TryValidateObject` calls, and many returned a plain string or a custom error object. .NET 10 adds built-in, source-generated validation for Minimal APIs. Call `AddValidation()` and annotated parameters are checked before the handler runs, and invalid requests get a standard `400` `HttpValidationProblemDetails` response.

## Implementation

1. Call `builder.Services.AddValidation()` (plus `AddProblemDetails()` so all errors share one format). An endpoint filter is added to every endpoint whose parameters have validation rules. Nothing else is needed for types used directly in handler signatures.
2. Declare rules with `System.ComponentModel.DataAnnotations` attributes on record constructor parameters, class properties, or handler parameters (`[Range(1, 100)] int limit`). Nested objects and collection items are validated recursively, and error keys look like `Items[0].Sku`.
3. Put cross-field rules in `IValidatableObject.Validate`. It runs only after all property-level rules pass. Write a custom `ValidationAttribute` for reusable single-value rules.
4. Rules that need I/O (uniqueness, existence of a foreign key) belong in the handler or service. Return `TypedResults.ValidationProblem(errors)` so the response has the same shape as automatic validation.
5. Opt out for a specific endpoint with `.DisableValidation()`, and for a property or type with `[SkipValidation]`.
6. For FluentValidation or other rule engines, register validators and run them in an endpoint filter on the route group (see below). It's an option, not a requirement. Don't run both systems on the same type.
7. Controllers already validate automatically through `[ApiController]` (`ModelState` produces a `400 ValidationProblemDetails`). `AddValidation` is for Minimal APIs.

## Example Code

```csharp
using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http.HttpResults;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddValidation();

var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages();

var registeredEmails = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "taken@example.com" };

// Invalid body -> automatic 400 before this code runs.
app.MapPost("/api/customers", Results<Created<CustomerDto>, ValidationProblem> (CreateCustomerRequest request) =>
{
    // Rule that needs data access: same response shape as automatic validation.
    if (registeredEmails.Contains(request.Email))
    {
        return TypedResults.ValidationProblem(new Dictionary<string, string[]>
        {
            [nameof(request.Email)] = ["Email is already registered."]
        });
    }

    var customer = new CustomerDto(Guid.CreateVersion7(), request.Name, request.Email);
    return TypedResults.Created($"/api/customers/{customer.Id}", customer);
});

// Query parameters are validated too.
app.MapGet("/api/customers", ([Range(1, 100)] int limit = 20) => TypedResults.Ok(new { limit }));

app.Run();

public record CreateCustomerRequest(
    [Required, StringLength(100)] string Name,
    [Required, EmailAddress] string Email,
    [Required] Address Address,
    [MaxLength(5)] List<PhoneNumber> Phones) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (Address.Country == "US" && Address.PostalCode.Length != 5)
        {
            yield return new ValidationResult("US postal codes have 5 digits.", [nameof(Address)]);
        }
    }
}

public record Address([Required] string Street, [Required, StringLength(2, MinimumLength = 2)] string Country, [Required] string PostalCode);
public record PhoneNumber([Required, Phone] string Number);
public record CustomerDto(Guid Id, string Name, string Email);
```

Optional FluentValidation hookup (package `FluentValidation`), applied per group with `.AddEndpointFilter<ValidationFilter<CreateCustomerRequest>>()`:

```csharp
public sealed class ValidationFilter<T>(IValidator<T> validator) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (context.Arguments.OfType<T>().FirstOrDefault() is { } argument)
        {
            var result = await validator.ValidateAsync(argument, context.HttpContext.RequestAborted);
            if (!result.IsValid)
            {
                return TypedResults.ValidationProblem(result.ToDictionary());
            }
        }
        return await next(context);
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Call `AddValidation()` from the assembly that declares the endpoints and request types. The source generator only finds types in that assembly. For types in a class library, add an extension method in that library that calls `services.AddValidation()` and call it from the host. Missing metadata fails silently: invalid input just reaches the handler.
- **MANDATORY**: Mark reference-type properties that must be present with `[Required]`. Nullable reference type annotations alone are not validation rules.
- **MANDATORY**: Return validation failures as `TypedResults.ValidationProblem(...)` (`400`, `application/problem+json`, `errors` dictionary), never as a plain string, a `200` with an error flag, or a custom error envelope.
- **DO NOT** hand-write `if (string.IsNullOrEmpty(request.Name)) return Results.BadRequest("Name required")` checks or call `Validator.TryValidateObject` in every handler on .NET 10. That is the outdated pattern this feature replaces.
- **DO NOT** throw exceptions (`ValidationException`) to signal invalid input and turn them into `400`s in an exception handler. Validation failures are expected results, not exceptions.
- **DO NOT** require FluentValidation or MediatR pipeline behaviors for simple rules. Data Annotations + `IValidatableObject` cover most API input. Use FluentValidation when rules are complex or must be shared outside HTTP.
- **DO NOT** assume unknown JSON properties are rejected. They are ignored by default. Set `JsonSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` (via `ConfigureHttpJsonOptions`) if clients must not send extra fields.
- On .NET 10, attributes on **nullable value type** handler parameters are skipped when the value is `null` (so `[Required] int? page` doesn't reject a missing value). Use a non-nullable parameter with a default value, or a property on a request record. This is fixed in .NET 11.
- Error keys use the C# member path (`Name`, `Address.Country`, `Phones[0].Number`), not the camelCase JSON name. Use `nameof(...)` for keys you add by hand so they match.

## Version notes

- `AddValidation`, `DisableValidation`, `[SkipValidation]` and `[ValidatableType]` for Minimal APIs: .NET 10 (package/namespace `Microsoft.Extensions.Validation`, included in the shared framework for web projects). In .NET 10, `[ValidatableType]`/`[SkipValidation]` are marked experimental (warning `ASP0029`) when used from plain class libraries. `[ValidatableType]` is only needed for root types not found from an endpoint signature. Both attributes are stable in .NET 11.
- On .NET 7–9, use an endpoint filter that runs `Validator.TryValidateObject` (top-level only) or FluentValidation, and return `TypedResults.ValidationProblem`. The `MinimalApis.Extensions` package's `WithParameterValidation()` is a common community option.
- Endpoint filters (`IEndpointFilter`, `AddEndpointFilter`) and `TypedResults.ValidationProblem`: .NET 7.

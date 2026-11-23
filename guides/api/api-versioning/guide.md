---
name: api-versioning
description: Version an ASP.NET Core HTTP API so breaking changes ship as new versions while old clients keep working and are told about deprecation.
keywords: [Asp.Versioning.Http, Asp.Versioning.Mvc, Asp.Versioning.Mvc.ApiExplorer, Asp.Versioning.OpenApi, AddApiVersioning, NewVersionedApi, HasApiVersion, HasDeprecatedApiVersion, MapToApiVersion, UrlSegmentApiVersionReader, HeaderApiVersionReader, ApiVersionReader.Combine, ReportApiVersions, AddApiExplorer, WithDocumentPerVersion, ApiVersion attribute, Sunset, Deprecation header]
---

# Version HTTP APIs with Asp.Versioning

Teams often "version" by copying controllers into `V2` folders with hard-coded `/api/v2/...` routes, or by quietly changing response shapes. Clients then can't tell which versions exist or when one goes away, and OpenAPI mixes all versions in one document. The `Asp.Versioning` libraries (formerly `Microsoft.AspNetCore.Mvc.Versioning`) handle version routing, reporting, deprecation and sunset policies, and per-version OpenAPI documents.

## Implementation

1. Install `Asp.Versioning.Http` for Minimal APIs or `Asp.Versioning.Mvc` for controllers. For per-version OpenAPI documents with the built-in generator, also install `Asp.Versioning.Mvc.ApiExplorer` and `Asp.Versioning.OpenApi`. Use the 10.x packages on .NET 10.
2. Call `AddApiVersioning(...)`. Choose **one** primary scheme and set `ApiVersionReader` to match. The default is the query string (`?api-version=1.0`).
   - URL segment (`/api/v1/orders`): `new UrlSegmentApiVersionReader()` with a `{version:apiVersion}` route parameter. Visible and cache-friendly; the most common choice for public APIs.
   - Header (`X-Api-Version: 1.0`): `new HeaderApiVersionReader("X-Api-Version")`. Keeps URLs stable, but is invisible in links and needs `Vary` handling in caches.
   - Combine readers only during a migration: `ApiVersionReader.Combine(...)`.
3. Set `ReportApiVersions = true` so responses include `api-supported-versions`/`api-deprecated-versions` headers.
4. Minimal APIs: `var api = app.NewVersionedApi("Orders");`, then one route group per version: `api.MapGroup("/api/v{version:apiVersion}/orders").HasApiVersion(2.0)`. Mark old versions with `HasDeprecatedApiVersion(1.0)`. Controllers: `[ApiVersion(2.0)]`, `[ApiVersion(1.0, Deprecated = true)]` and `[MapToApiVersion]` on actions.
5. Publish deprecation and sunset dates with `options.Policies.Deprecate(1.0).Effective(...)` and `options.Policies.Sunset(1.0).Effective(...).Link(...)`. Requests for that version then get `Deprecation`, `Sunset` and `Link` headers (RFC 9745/8594).
6. OpenAPI: `.AddApiExplorer(o => { o.GroupNameFormat = "'v'VVV"; o.SubstituteApiVersionInUrl = true; }).AddOpenApi()` and `app.MapOpenApi().WithDocumentPerVersion()` give `/openapi/v1.json`, `/openapi/v2.json`.
7. Only create a new major version for breaking changes. Adding optional fields or new endpoints is not breaking.

## Example Code

```csharp
using Asp.Versioning;
using Microsoft.AspNetCore.Http.HttpResults;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services
    .AddApiVersioning(options =>
    {
        options.DefaultApiVersion = new ApiVersion(2, 0);
        options.ReportApiVersions = true;
        options.ApiVersionReader = new UrlSegmentApiVersionReader();

        options.Policies.Deprecate(1.0)
            .Effective(2026, 6, 1)
            .Link("https://docs.example.com/api/deprecation").Title("Deprecation policy").Type("text/html");
        options.Policies.Sunset(1.0)
            .Effective(2027, 1, 1)
            .Link("https://docs.example.com/api/sunset").Title("Sunset policy").Type("text/html");
    })
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";          // v1, v2
        options.SubstituteApiVersionInUrl = true;    // /api/v1/orders in the document, not {version}
    })
    .AddOpenApi();                                   // Asp.Versioning.OpenApi

var app = builder.Build();

app.MapOpenApi().WithDocumentPerVersion();           // /openapi/v1.json, /openapi/v2.json

var orders = app.NewVersionedApi("Orders");

var v1 = orders.MapGroup("/api/v{version:apiVersion}/orders").HasDeprecatedApiVersion(1.0);
v1.MapGet("/{id:int}", Results<Ok<OrderV1>, NotFound> (int id) =>
    id > 0 ? TypedResults.Ok(new OrderV1(id, 42m)) : TypedResults.NotFound());

var v2 = orders.MapGroup("/api/v{version:apiVersion}/orders").HasApiVersion(2.0);
v2.MapGet("/{id:int}", Results<Ok<OrderV2>, NotFound> (int id) =>
    id > 0 ? TypedResults.Ok(new OrderV2(id, new Money(42m, "EUR"))) : TypedResults.NotFound());

app.Run();

public record OrderV1(int Id, decimal Total);
public record OrderV2(int Id, Money Total);
public record Money(decimal Amount, string Currency);
```

## Best Practices & Constraints

- **MANDATORY**: Use `Asp.Versioning.*` packages. `Microsoft.AspNetCore.Mvc.Versioning` and `Microsoft.AspNetCore.Mvc.Versioning.ApiExplorer` are the deprecated predecessors (last release 5.x) and don't support Minimal APIs.
- **MANDATORY**: Every versioned API needs a version from day one (`v1`). Adding versioning later to unversioned routes forces `AssumeDefaultVersionWhenUnspecified` hacks.
- **MANDATORY**: With URL segment versioning, every versioned route must contain `{version:apiVersion}`. Otherwise requests fail to match with `400`/`404` errors.
- **DO NOT** hard-code `/api/v1/...` and `/api/v2/...` as plain route prefixes and duplicate code without the library. You lose version negotiation, `api-supported-versions` reporting, deprecation headers and per-version documents.
- **DO NOT** set `AssumeDefaultVersionWhenUnspecified = true` for new APIs. Clients that omit the version get silently pinned to whatever the default becomes. Use it only to keep pre-versioning clients working.
- **DO NOT** remove a version without first marking it deprecated, publishing a sunset policy, and watching traffic to that version.
- **DO NOT** register separate `AddOpenApi("v1")`/`AddOpenApi("v2")` documents by hand when using Asp.Versioning 10. `.AddOpenApi()` + `WithDocumentPerVersion()` builds them from the API explorer.
- Share handlers and services across versions. Version the request/response contracts (separate DTO records), not the business logic.

## Version notes

- Asp.Versioning 10.x targets .NET 10 and adds the `Asp.Versioning.OpenApi` package (integration with `Microsoft.AspNetCore.OpenApi`, `WithDocumentPerVersion()`), deprecation policies (`Policies.Deprecate`, RFC 9745 `Deprecation` header), and date-based `[ApiVersion(2026, 04, 01)]` constructors. 8.x works on .NET 10 through roll-forward but lacks this OpenAPI integration.
- Asp.Versioning 8.x targets .NET 8. With it, generate per-version documents with Swashbuckle (or manual `AddOpenApi("v1")` registrations plus a filtering transformer on .NET 9). Sunset policies (`Policies.Sunset`) exist in 6.x+.
- `NewVersionedApi` + `MapGroup(...).HasApiVersion(...)` needs route groups (.NET 7+) and Asp.Versioning 7+. On .NET 6, use `NewApiVersionSet()` + `.WithApiVersionSet(...)`, which still works but is more verbose.

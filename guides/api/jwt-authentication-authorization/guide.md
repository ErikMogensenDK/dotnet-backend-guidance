---
name: jwt-authentication-authorization
description: Protect ASP.NET Core API endpoints with bearer access tokens and enforce permissions with authorization policies.
keywords: [AddAuthentication, AddJwtBearer, Microsoft.AspNetCore.Authentication.JwtBearer, JwtBearerOptions, JwtBearerDefaults, TokenValidationParameters, Authority, Audience, ValidAudiences, ValidIssuers, MapInboundClaims, AddAuthorizationBuilder, AddPolicy, SetFallbackPolicy, RequireAuthorization, AllowAnonymous, Authorize attribute, ClaimsPrincipal, dotnet user-jwts]
---

# Authenticate APIs with JWT Bearer Tokens and Authorization Policies

Common mistakes in API auth code: parsing the `Authorization` header and validating tokens with `JwtSecurityTokenHandler` by hand, turning off `ValidateAudience`/`ValidateIssuer` to "make it work", hard-coding a symmetric secret, and checking roles with `if (User.IsInRole(...))` inside handlers. Use the JWT bearer handler to validate tokens issued by your identity provider (Entra ID, Auth0, Keycloak, Duende, …). It reads the signing keys from the provider's OpenID Connect metadata. Express permissions as named authorization policies attached to endpoints and route groups.

## Implementation

1. Add the `Microsoft.AspNetCore.Authentication.JwtBearer` package. Call `AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(...)` and set `Authority` (the issuer URL; signing keys and issuer come from `{Authority}/.well-known/openid-configuration`) and `Audience` (this API's identifier). Read both from configuration.
2. Set `MapInboundClaims = false` so claims keep their JWT names (`sub`, `scope`, `roles`) instead of being renamed to long `http://schemas.xmlsoap.org/...` URIs.
3. Define policies with `builder.Services.AddAuthorizationBuilder().AddPolicy(...)`. Base them on scopes/permissions or roles from the token. Note that `scope` (or Entra's `scp`) is a single space-separated claim, so `RequireClaim("scope", "orders.write")` fails when the token has several scopes.
4. Set a fallback policy (`SetFallbackPolicy(...RequireAuthenticatedUser()...)`) so endpoints are protected by default. Opt out explicitly with `.AllowAnonymous()` for health checks, the OpenAPI document, and similar.
5. Attach policies with `.RequireAuthorization("policy")` on route groups or endpoints (`[Authorize(Policy = "...")]` on controllers). Read the caller from the `ClaimsPrincipal user` handler parameter.
6. Call `app.UseAuthentication()` then `app.UseAuthorization()` after `UseRouting`/CORS and before the endpoints. `WebApplication` adds them automatically when the services are registered, but explicit calls make the order obvious when other middleware (rate limiting, timeouts) depends on the user.
7. For local development, mint test tokens with `dotnet user-jwts create --audience <aud> --scope orders.write`. It writes matching `Authentication:Schemes:Bearer` settings to `appsettings.Development.json`, so don't hard-code a dev signing key.

## Example Code

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = builder.Configuration["Auth:Authority"];  // e.g. https://login.example.com/
        options.Audience = builder.Configuration["Auth:Audience"];    // e.g. api://orders
        options.MapInboundClaims = false;
        // Signature, issuer, audience and lifetime are validated by default. Don't disable them.
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("orders:read", policy => policy.RequireAuthenticatedUser().RequireAssertion(ctx => HasScope(ctx.User, "orders.read")))
    .AddPolicy("orders:write", policy => policy.RequireAuthenticatedUser().RequireAssertion(ctx => HasScope(ctx.User, "orders.write")))
    .AddPolicy("admin", policy => policy.RequireRole("admin"))
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => "ok").AllowAnonymous();

var orders = app.MapGroup("/api/orders").RequireAuthorization("orders:read");
orders.MapGet("/", (ClaimsPrincipal user) => TypedResults.Ok(new { owner = user.FindFirstValue("sub") }));
orders.MapPost("/", (ClaimsPrincipal user) => TypedResults.Accepted("/api/orders/1"))
      .RequireAuthorization("orders:write");   // combined with the group policy: both must pass

app.MapDelete("/api/admin/orders/{id:int}", (int id) => TypedResults.NoContent()).RequireAuthorization("admin");

app.Run();

static bool HasScope(ClaimsPrincipal user, string scope) =>
    user.FindAll("scope").Concat(user.FindAll("scp"))
        .SelectMany(c => c.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        .Contains(scope, StringComparer.Ordinal);
```

## Best Practices & Constraints

- **MANDATORY**: Keep `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` and `ValidateIssuerSigningKey` enabled (the defaults). If tokens are rejected, fix `Authority`/`Audience` (or `ValidIssuers`/`ValidAudiences` for multiple values) instead of disabling checks.
- **MANDATORY**: Get signing keys from the identity provider's metadata (`Authority`/`MetadataAddress`) with asymmetric keys. A hard-coded `SymmetricSecurityKey` from `appsettings.json` is only for tests.
- **MANDATORY**: Protect by default with a fallback policy and use `.AllowAnonymous()` as the explicit exception.
- **DO NOT** validate tokens by hand (`new JwtSecurityTokenHandler().ValidateToken(...)` in middleware or handlers) or decode the payload and trust it without validating the signature.
- **DO NOT** build a `/login` endpoint that takes username/password and returns a self-signed JWT. Use an OpenID Connect/OAuth provider. ASP.NET Core Identity's `MapIdentityApi` is an option for simple first-party apps, but it issues its own opaque bearer tokens, not JWTs.
- **DO NOT** check roles or permissions with `if` statements in every handler. Use policies, plus resource-based authorization (`IAuthorizationService.AuthorizeAsync(user, resource, policy)`) for "owner only" rules.
- **DO NOT** set `RequireHttpsMetadata = false` outside local development, or log raw tokens.
- **DO NOT** rely on `ClaimTypes.NameIdentifier` after setting `MapInboundClaims = false`. Read `sub` (or your provider's user ID claim) directly.
- A missing or invalid token returns `401` with a `WWW-Authenticate: Bearer` header. A valid token that fails a policy returns `403`. Don't rewrite these to `400`/`404`.

## Version notes

- `AddAuthorizationBuilder()`, `dotnet user-jwts`, and automatic binding of `Authentication:Schemes:Bearer` configuration: .NET 7. On .NET 6, use `AddAuthorization(o => o.AddPolicy(...))`.
- .NET 8: the JWT bearer handler validates with `JsonWebTokenHandler` (`Microsoft.IdentityModel.JsonWebTokens`) instead of `JwtSecurityTokenHandler`. `SecurityTokenValidators` is obsolete (use `TokenHandlers`), and `context.SecurityToken` in events is a `JsonWebToken`, not a `JwtSecurityToken`. Code that casts to `JwtSecurityToken` breaks. `options.UseSecurityTokenValidators = true` restores the old behavior temporarily.
- .NET 8 also added `MapIdentityApi` (Identity bearer tokens).
- .NET 10: authentication/authorization metrics are built in, and cookie auth returns `401`/`403` for API endpoints instead of redirecting (relevant if an API mixes cookie and bearer schemes).
- Use the `Microsoft.AspNetCore.Authentication.JwtBearer` package version that matches your target framework major version (10.x for .NET 10).

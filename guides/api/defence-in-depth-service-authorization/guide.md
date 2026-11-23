---
name: defence-in-depth-service-authorization
description: Enforce operation permissions before data access, check resource permissions after lookup, and audit access decisions inside API services.
keywords: [defence in depth, defense in depth, authorization, operation permissions, resource-based authorization, data access control, IPermissionService, ProductService, ServiceResult, NoAccessToOperation, NoAccessToData, IAuditService, audit trail, IDOR, BOLA, market permissions]
---

# Authorize Operations First, Then Authorize Access to Data

Endpoint authentication and authorization are the first layer, not the only layer. A caller may be allowed to read products but not products belonging to every market. Enforce both permissions in the service so another endpoint, background job or internal caller cannot bypass the checks by calling the service directly.

Use a consistent order: operation permission, input validation, the minimum lookup needed for data authorization, data permission, business logic, then a success audit event. Reject denied operations before querying the repository. When data permissions depend on the stored resource, load that resource before checking them, but do not process or return protected data until the check passes.

## Implementation

1. Keep authentication and endpoint policies at the API boundary. Inject a permission service that represents the authenticated caller; do not accept caller identity, roles or permitted markets from the request body.
2. Check permission to perform the operation first in every service method. Audit a denial and return `NoAccessToOperation` before repository access or business processing.
3. Validate service inputs as early as possible after the operation check. HTTP binding and request validation can run before the service; validated domain primitives such as `ProductId` keep invalid identifiers out of the domain method.
4. Load only the data needed to locate the resource and determine access. Return `NotFound` if it does not exist.
5. Check access to the resource using its stored authorization attributes, such as `product.MarketId`, not a market supplied by the caller. Audit a denial and return `NoAccessToData`.
6. Run the remaining business logic only after both checks pass. Await the success audit event before returning `Success(product)`.
7. Translate service results into HTTP responses at the endpoint boundary. Keep operation denial distinct from data denial inside the service, even when the API intentionally hides resource existence.

## Example Code

Adapted from `guidance-example/9-complete-with-all-defence-layers/Domain/Services/ProductService.cs`. The application contracts used here are: `ProductId` is a validated identifier, `Product` has a `MarketId`, the repository returns `Product?`, and `ServiceResult<T>` carries either a value or one of the named failure outcomes. The permission service evaluates the current caller, and the audit service records the event, caller and product identifier.

```csharp
using Defence.In.Depth.Domain.Models;
using Defence.In.Depth.Infrastructure;

namespace Defence.In.Depth.Domain.Services;

public class ProductService(
    IPermissionService permissionService,
    IProductRepository productRepository,
    IAuditService auditService)
    : IProductService
{
    public async Task<ServiceResult<Product>> GetById(ProductId productId)
    {
        // 1. Authorize the operation before accessing any product data.
        if (!permissionService.CanReadProducts)
        {
            await auditService.Log(DomainEvent.NoAccessToOperation, productId);

            return ServiceResult<Product>.NoAccessToOperation;
        }

        // ProductId is already validated. Load the resource to learn its market.
        var product = await productRepository.GetById(productId);

        if (product is null)
        {
            return ServiceResult<Product>.NotFound;
        }

        // 2. Authorize access to the stored resource before processing it.
        if (!permissionService.HasPermissionToMarket(product.MarketId))
        {
            await auditService.Log(DomainEvent.NoAccessToData, productId);

            return ServiceResult<Product>.NoAccessToData;
        }

        // Business logic, such as checking availability in stores, belongs here.

        await auditService.Log(DomainEvent.ProductRead, productId);

        return ServiceResult<Product>.Success(product);
    }
}
```

For an authenticated API caller, map `NoAccessToOperation` to `403 Forbidden`, `NotFound` and `NoAccessToData` to the same `404 Not Found` response, and `Success` to `200 OK` with the mapped response DTO. This deliberate resource-concealment policy avoids revealing whether a product exists in another market. Authentication failures still produce `401` at the API boundary; do not disguise those as `404`. The service does not depend on HTTP status codes, `IResult` or `HttpContext`.

## Best Practices & Constraints

- Keep the operation check first even when endpoint policies already enforce it. Endpoint policies protect HTTP entry points; service checks protect the operation across callers.
- Resolve permission and audit services in the current caller's scope. Non-HTTP callers need an explicit trusted caller context; a missing `HttpContext` must not grant access.
- Do not trust possession of a product ID as authorization. Check the resource's market, tenant, owner or other relevant access boundary.
- A lookup before the data check is necessary when authorization attributes are not yet known. It is not permission to perform unrelated processing, mutations or external calls before authorization.
- For searches, apply access restrictions in the query where possible. If a rule requires inspecting computed candidates, authorize them before exposing results, counts, aggregates or pagination metadata. Keep the operation check first in either case.
- Record operation denials, data denials and successful reads as distinct audit events. Include trusted caller identity and correlation information without logging tokens or full sensitive product payloads. This example returns `NotFound` without a read-success audit event.
- Await audit writes; do not use fire-and-forget logging for required audit records. Define audit durability and failure handling explicitly. In this example, an audit exception propagates rather than returning success without the required audit write.
- Keep expected access denials as service results. Let unexpected repository and audit failures propagate to the API's exception handler; do not turn infrastructure outages into `NotFound` or permission denials.
- Test the observable boundaries: operation denial performs no product lookup; a missing product returns `NotFound`; an existing product in a forbidden market returns `NoAccessToData` without business processing; an allowed product returns success. Verify the corresponding denial or success audit event and that missing and forbidden resources have indistinguishable public responses.

## Version notes

- The example uses C# 12 primary constructors (.NET 8+ by default), matching the local defence-in-depth example. On older projects, use an ordinary constructor with fields.
- `IPermissionService`, `IAuditService`, `ServiceResult<T>` and the domain primitives are application types, not ASP.NET Core APIs. Keep the project's existing result and permission abstractions rather than introducing a second set solely for this pattern.

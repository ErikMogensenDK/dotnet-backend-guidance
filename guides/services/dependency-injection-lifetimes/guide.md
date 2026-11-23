---
name: dependency-injection-lifetimes
description: Choose singleton, scoped or transient lifetimes correctly, avoid captive dependencies, and catch DI registration mistakes at startup.
keywords: [IServiceCollection, AddSingleton, AddScoped, AddTransient, IServiceScopeFactory, CreateAsyncScope, ServiceProviderOptions, ValidateScopes, ValidateOnBuild, UseDefaultServiceProvider, AddKeyedSingleton, AddKeyedScoped, FromKeyedServices, ServiceKey, KeyedService.AnyKey, captive dependency, service locator, Microsoft.Extensions.DependencyInjection]
---

# Choose Dependency Injection Lifetimes and Avoid Captive Dependencies

Lifetime bugs compile and often pass tests. A scoped `DbContext` injected into a singleton becomes one shared, non-thread-safe instance for the whole process (a *captive dependency*). `IServiceProvider.GetService` calls inside classes hide dependencies until runtime. The default host validates scopes only in the Development environment, so these bugs reach production unless you turn validation on everywhere.

## Implementation

1. **Pick the lifetime from the state the service holds:**
   - singleton: stateless or thread-safe shared state (`TimeProvider`, caches, metrics)
   - scoped: per-request or unit-of-work state (`DbContext`, repositories, the current user)
   - transient: lightweight stateless helpers
2. **Depend only on equal or longer lifetimes.** Singletons depend only on singletons. A transient takes on the lifetime of its consumer.
3. **Validate in every environment** with `builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; })`. For `HostApplicationBuilder`, use `builder.ConfigureContainer(new DefaultServiceProviderFactory(new ServiceProviderOptions { ... }))`.
4. **When a singleton needs scoped work** (hosted services, message handlers), inject `IServiceScopeFactory` and create one scope per unit of work with `await using var scope = scopeFactory.CreateAsyncScope()`.
5. **Select between implementations of one interface with keyed services:** `AddKeyedSingleton<TService, TImpl>(key)` to register, and `[FromKeyedServices(key)]` on constructor, minimal API or action parameters to consume. `[ServiceKey]` injects the key into the implementation.

## Example Code

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Shop.Services;

public static class NotifierKeys
{
    public const string Email = "email";
    public const string Sms = "sms";
}

public interface INotifier
{
    Task SendAsync(string recipient, string message, CancellationToken ct);
}

public sealed class EmailNotifier : INotifier
{
    public Task SendAsync(string recipient, string message, CancellationToken ct) => Task.CompletedTask;
}

public sealed class SmsNotifier([ServiceKey] string key) : INotifier
{
    public string Channel { get; } = key; // receives "sms"
    public Task SendAsync(string recipient, string message, CancellationToken ct) => Task.CompletedTask;
}

public interface IOrderRepository // scoped: wraps a DbContext in a real app
{
    Task<IReadOnlyList<string>> GetUnpaidCustomerPhonesAsync(CancellationToken ct);
}

public sealed class OrderRepository : IOrderRepository
{
    public Task<IReadOnlyList<string>> GetUnpaidCustomerPhonesAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<string>>(["+4512345678"]);
}

// Singleton that needs scoped services: depends on IServiceScopeFactory, not on IOrderRepository.
public sealed class PaymentReminder(
    IServiceScopeFactory scopeFactory,
    [FromKeyedServices(NotifierKeys.Sms)] INotifier notifier)
{
    public async Task RemindAsync(CancellationToken ct)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        var orders = scope.ServiceProvider.GetRequiredService<IOrderRepository>();

        foreach (string phone in await orders.GetUnpaidCustomerPhonesAsync(ct))
        {
            await notifier.SendAsync(phone, "Your order is awaiting payment.", ct);
        }
    }
}

public static class ServiceRegistration
{
    public static WebApplicationBuilder AddShopServices(this WebApplicationBuilder builder)
    {
        // Fail at startup, in every environment, instead of at first request.
        builder.Host.UseDefaultServiceProvider(options =>
        {
            options.ValidateScopes = true;
            options.ValidateOnBuild = true;
        });

        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddScoped<IOrderRepository, OrderRepository>();
        builder.Services.AddKeyedSingleton<INotifier, EmailNotifier>(NotifierKeys.Email);
        builder.Services.AddKeyedSingleton<INotifier, SmsNotifier>(NotifierKeys.Sms);
        builder.Services.AddSingleton<PaymentReminder>();
        return builder;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Enable `ValidateScopes` and `ValidateOnBuild` outside Development. `ValidateOnBuild` can't see inside factory lambdas (`sp => new Foo(sp.GetRequiredService<Bar>())`), so prefer type registrations.
- **MANDATORY**: Resolve scoped services from a scope you create and dispose, never from the root `app.Services`.
- **DO NOT** inject scoped services (`DbContext`, `IOptionsSnapshot<T>`, anything that depends on them) into singletons, hosted services or conventional middleware constructors. Middleware takes scoped services as `InvokeAsync` parameters.
- **DO NOT** use the service-locator pattern: injecting `IServiceProvider` into business classes and calling `GetService<T>()`. Only composition code (factories, `IServiceScopeFactory` in singletons) touches the provider.
- **DO NOT** call `services.BuildServiceProvider()` during registration (analyzer ASP0000). It creates a second container with duplicate singletons.
- **DO NOT** capture a scoped instance in a singleton's field, closure or `Lazy<T>`. Validation can't detect this.
- **DO NOT** resolve transient `IDisposable`s from the root provider repeatedly. The root keeps them until shutdown, which leaks memory.
- **DO NOT** dispose container-resolved services yourself. The container never disposes instances you passed in (`AddSingleton(new Foo())`).
- Use `const` strings or enums as keys so they work in attributes.

## Version notes

- `ValidateScopes`/`ValidateOnBuild`: .NET Core 3.0+. The default host enables both only in `Development`.
- `CreateAsyncScope`: .NET 6+. Older versions use `using var scope = scopeFactory.CreateScope()`.
- Keyed services (`AddKeyed*`, `[FromKeyedServices]`, `[ServiceKey]`, `KeyedService.AnyKey`), including in minimal API and MVC parameters: .NET 8+. Earlier versions inject `IEnumerable<T>` and select, or register a `Func<string, T>` factory.
- .NET 10 breaking change: `GetKeyedService<T>(KeyedService.AnyKey)` throws `InvalidOperationException`, and `GetKeyedServices<T>(KeyedService.AnyKey)` no longer returns `AnyKey` fallback registrations.

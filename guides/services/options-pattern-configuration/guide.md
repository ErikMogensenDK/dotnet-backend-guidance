---
name: options-pattern-configuration
description: Bind configuration to strongly typed, validated settings classes that fail fast at startup and keep secrets out of appsettings.json.
keywords: [IOptions, IOptionsSnapshot, IOptionsMonitor, AddOptions, BindConfiguration, ValidateDataAnnotations, ValidateOnStart, OptionsValidator, IValidateOptions, ValidateObjectMembers, ValidateEnumeratedItems, OptionsValidationException, EnableConfigurationBindingGenerator, IConfiguration, user-secrets, AddAzureKeyVault, Microsoft.Extensions.Options]
---

# Bind and Validate Settings with the Options Pattern

Reading `IConfiguration["Section:Key"]` inside services scatters magic strings, fails at the first request instead of at startup, and makes services hard to test. Plain `services.Configure<T>(section)` doesn't validate anything, so a missing URL or a mistyped key becomes a `null` property in production. Bind each section once to a class, validate it at startup, and inject typed options.

## Implementation

1. **One POCO per section.** Give it a `const string SectionName`, settable properties with defaults, and DataAnnotations (`[Required]`, `[Range]`, `[Url]`).
2. **Register with** `AddOptions<T>().BindConfiguration(T.SectionName)`, then validation, then `.ValidateOnStart()`.
3. **Validate with the source generator (.NET 8+):** declare an empty `[OptionsValidator] partial class XValidator : IValidateOptions<X>` and register it as a singleton. It avoids reflection and works with AOT. The alternative is `.ValidateDataAnnotations()`, which uses reflection. Add `.Validate(o => ..., "message")` for rules across properties.
4. **Nested objects and collections are only validated** when the property is marked `[ValidateObjectMembers]` or `[ValidateEnumeratedItems]` (source generator).
5. **Choose the interface by the consumer's lifetime:**
   - `IOptions<T>`: singleton, read once, no reload. This is the default.
   - `IOptionsSnapshot<T>`: scoped, recomputed per request.
   - `IOptionsMonitor<T>`: singleton, with `CurrentValue` and `OnChange`, for singletons that need reloads.
6. **Secrets come from user secrets in development** (`dotnet user-secrets set "PaymentGateway:ApiKey" ...`). **In production, use environment variables** (`PaymentGateway__ApiKey`) or a vault, for example `builder.Configuration.AddAzureKeyVault(uri, new DefaultAzureCredential())` from `Azure.Extensions.AspNetCore.Configuration.Secrets`. They bind like any other value.

## Example Code

```csharp
using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Shop.Payments;

public sealed class PaymentGatewayOptions
{
    public const string SectionName = "PaymentGateway";

    [Required, Url]
    public string BaseUrl { get; set; } = "";

    [Required] // supplied by user-secrets / env var / Key Vault, never appsettings.json
    public string ApiKey { get; set; } = "";

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [ValidateObjectMembers] // without this, RetrySettings attributes are ignored
    public RetrySettings Retry { get; set; } = new();
}

public sealed class RetrySettings
{
    [Range(0, 10)]
    public int MaxAttempts { get; set; } = 3;
}

[OptionsValidator] // compile-time generated, reflection-free validation
public sealed partial class PaymentGatewayOptionsValidator : IValidateOptions<PaymentGatewayOptions>
{
}

public sealed class PaymentGatewayClient(IOptionsMonitor<PaymentGatewayOptions> options)
{
    // Singleton: read CurrentValue per call so configuration reloads are picked up.
    public TimeSpan Timeout => TimeSpan.FromSeconds(options.CurrentValue.TimeoutSeconds);
}

public static class PaymentRegistration
{
    public static IServiceCollection AddPayments(this IServiceCollection services)
    {
        services.AddOptions<PaymentGatewayOptions>()
            .BindConfiguration(PaymentGatewayOptions.SectionName)
            .Validate(o => !o.BaseUrl.StartsWith("http:", StringComparison.OrdinalIgnoreCase),
                "PaymentGateway:BaseUrl must use https.")
            .ValidateOnStart(); // host refuses to start with invalid settings

        services.AddSingleton<IValidateOptions<PaymentGatewayOptions>, PaymentGatewayOptionsValidator>();
        services.AddSingleton<PaymentGatewayClient>();
        return services;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: End every registration with `.ValidateOnStart()`. Without it, validation runs at the first `.Value`/`.CurrentValue` read, possibly minutes after deployment.
- **DO NOT** inject `IConfiguration` into services or call `configuration["X:Y"]`/`GetValue<T>` outside `Program.cs`. Pass plain values to domain types, not `IOptions<T>`.
- **DO NOT** default to `services.Configure<T>(config.GetSection(...))` without validation.
- **DO NOT** inject `IOptionsSnapshot<T>` into singletons or hosted services. It's scoped, so scope validation throws.
- **DO NOT** cache `IOptionsMonitor<T>.CurrentValue` in a field. Read it each time. `OnChange` can fire more than once per file save.
- **DO NOT** put secrets (passwords, API keys, signing keys) in `appsettings*.json` or source control.
- **DO NOT** rely on the C# `required` modifier to catch missing keys. The binder creates the object at runtime and ignores it. Use defaults (`= ""`) plus `[Required]`.
- A reload with invalid values makes `CurrentValue`/`Get` throw `OptionsValidationException`. Handle that in long-running consumers.
- For named options, use `AddOptions<T>("name")` and read with `IOptionsMonitor<T>.Get("name")`. `IOptions<T>` only supports the default name.
- For AOT or trimming, set `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>`. Outside ASP.NET Core, `ValidateDataAnnotations` needs the `Microsoft.Extensions.Options.DataAnnotations` package.

## Version notes

- `AddOptions<T>`, `ValidateDataAnnotations`, `IOptionsSnapshot` and `IOptionsMonitor` exist in every supported .NET version, and so does `BindConfiguration`.
- `ValidateOnStart()`: .NET 6+. Earlier versions resolve `IOptions<T>.Value` once at startup instead.
- `[OptionsValidator]`, `[ValidateObjectMembers]`, `[ValidateEnumeratedItems]` and the configuration-binding generator: .NET 8+ (`Microsoft.Extensions.Options` 8.0). Earlier versions use `ValidateDataAnnotations()` plus a hand-written `IValidateOptions<T>` for nested objects.

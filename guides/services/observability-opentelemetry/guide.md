---
name: observability-opentelemetry
description: Emit traces, metrics and logs from a .NET service with OpenTelemetry, including custom spans and business metrics, and export them over OTLP.
keywords: [OpenTelemetry, AddOpenTelemetry, WithTracing, WithMetrics, WithLogging, UseOtlpExporter, AddOtlpExporter, ConfigureResource, AddService, ActivitySource, StartActivity, IMeterFactory, Meter, Counter, AddSource, AddMeter, OTEL_EXPORTER_OTLP_ENDPOINT, OpenTelemetry.Extensions.Hosting, OpenTelemetry.Exporter.OpenTelemetryProtocol, Aspire ServiceDefaults, AddServiceDefaults]
---

# Instrument a .NET Service with OpenTelemetry

.NET has the instrumentation APIs built in: `ActivitySource` for traces, `Meter` for metrics and `ILogger` for logs. The OpenTelemetry SDK collects them and exports them over OTLP to any backend. Vendor SDKs, such as the classic Application Insights `TelemetryClient`, and custom correlation-ID middleware lock you to one vendor and lose automatic trace/log correlation.

## Implementation

1. **Add the packages:** `OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Exporter.OpenTelemetryProtocol`, `OpenTelemetry.Instrumentation.AspNetCore` and `OpenTelemetry.Instrumentation.Http`, plus optionally `OpenTelemetry.Instrumentation.Runtime`.
2. **Register once:** `AddOpenTelemetry()`, then `.ConfigureResource(r => r.AddService(...))`, `.WithTracing(...)`, `.WithMetrics(...)` and `.UseOtlpExporter()`, which exports every signal that's enabled. Bridge logs with `builder.Logging.AddOpenTelemetry(...)`.
3. **Configure the exporter with environment variables:** `OTEL_EXPORTER_OTLP_ENDPOINT` (default gRPC `localhost:4317`), `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.
4. **Custom spans:** use one `static readonly ActivitySource` per component, registered with `.AddSource(name)`. Wrap work in `using Activity? a = source.StartActivity("Name")`. On failure, call `SetStatus(ActivityStatusCode.Error)` and `AddException(ex)`.
5. **Custom metrics:** in a singleton, call `IMeterFactory.Create(name)` and create instruments once. Register the meter with `.AddMeter(name)`. Use semantic-convention names: lowercase dotted names (`shop.orders.placed`) and UCUM units (`s`, `By`, `{order}`).
6. **With .NET Aspire,** `builder.AddServiceDefaults()` already does steps 2–3. It turns on `UseOtlpExporter()` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and adds a source named after `Environment.ApplicationName`. Add your sources and meters in ServiceDefaults or through `ConfigureOpenTelemetryTracerProvider`/`ConfigureOpenTelemetryMeterProvider`. Don't add a second exporter setup.

## Example Code

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Shop.Telemetry;

public static class ShopTelemetry
{
    public const string SourceName = "Shop.Checkout";
    public static readonly ActivitySource ActivitySource = new(SourceName);
}

public sealed class CheckoutMetrics(IMeterFactory meterFactory)
{
    private readonly Counter<long> _ordersPlaced = meterFactory
        .Create(ShopTelemetry.SourceName)
        .CreateCounter<long>("shop.orders.placed", unit: "{order}");

    // Low-cardinality tags only: never user/order IDs.
    public void OrderPlaced(string paymentMethod) =>
        _ordersPlaced.Add(1, new KeyValuePair<string, object?>("shop.payment_method", paymentMethod));
}

public sealed class CheckoutService(CheckoutMetrics metrics)
{
    public async Task<Guid> CheckoutAsync(string cartId, string paymentMethod, CancellationToken ct)
    {
        using Activity? activity = ShopTelemetry.ActivitySource.StartActivity("Checkout");
        activity?.SetTag("shop.cart_id", cartId); // IDs are fine on spans
        try
        {
            await Task.Delay(20, ct); // payment + persistence
            metrics.OrderPlaced(paymentMethod);
            return Guid.CreateVersion7();
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddException(ex);
            throw;
        }
    }
}

public static class TelemetryRegistration
{
    public static IHostApplicationBuilder AddShopTelemetry(this IHostApplicationBuilder builder)
    {
        builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.IncludeFormattedMessage = true; });

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .AddService("shop-api", serviceVersion: "1.4.0")
                .AddAttributes([new("deployment.environment.name", builder.Environment.EnvironmentName)]))
            .WithTracing(t => t
                .AddSource(ShopTelemetry.SourceName)
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation())
            .WithMetrics(m => m
                .AddMeter(ShopTelemetry.SourceName)
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation())
            .UseOtlpExporter(); // endpoint/protocol from OTEL_EXPORTER_OTLP_* env vars

        builder.Services.AddSingleton<CheckoutMetrics>();
        builder.Services.AddScoped<CheckoutService>();
        return builder;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Register every custom source with `AddSource` and every meter with `AddMeter`. Wildcards like `"Shop.*"` work. Otherwise `StartActivity` returns `null` and the instruments record nothing.
- **MANDATORY**: Use `activity?.`. `StartActivity` returns `null` when nobody listens or the trace isn't sampled.
- **MANDATORY**: Set `service.name` with `AddService` or `OTEL_SERVICE_NAME`. Otherwise backends show `unknown_service`.
- **DO NOT** combine `UseOtlpExporter()` with a signal-specific `AddOtlpExporter()`, or call it twice. Both throw `NotSupportedException`.
- **DO NOT** use `new Meter(...)` in DI code. `IMeterFactory` isolates meters per container, which keeps tests independent. A `static ActivitySource` is fine.
- **DO NOT** put unbounded values (user or order IDs, raw URLs) in metric tags, because each combination becomes a time series. Never put PII in any tag.
- **DO NOT** build new telemetry on vendor SDKs or hand-rolled correlation-ID middleware. `traceparent` propagation and `TraceId`/`SpanId` on logs are automatic. For Azure Monitor, use `Azure.Monitor.OpenTelemetry.AspNetCore` (`UseAzureMonitor()`).
- Filter health checks out of traces with `AddAspNetCoreInstrumentation(o => o.Filter = ...)`. In production, sample traces, for example with `ParentBasedSampler(new TraceIdRatioBasedSampler(0.1))`.

## Version notes

- `IMeterFactory` and the built-in ASP.NET Core, Kestrel and `HttpClient` meters: .NET 8+. On .NET 6/7, use a `static readonly Meter`.
- `Activity.AddException` and `Guid.CreateVersion7()`: .NET 9+. On older versions, add an `ActivityEvent("exception")` with `exception.type` and `exception.message` tags.
- OpenTelemetry .NET: `UseOtlpExporter()` needs 1.8.0+, and `WithLogging()` is stable from 1.9.0. Earlier versions need `AddOtlpExporter()` per signal.
- Current Aspire ServiceDefaults templates target `net10.0` and also add `AddStandardResilienceHandler` and service discovery to every `HttpClient`.

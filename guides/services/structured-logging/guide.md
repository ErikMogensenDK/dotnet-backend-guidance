---
name: structured-logging
description: Write fast, queryable structured logs with ILogger message templates and source-generated log methods, without leaking sensitive data.
keywords: [ILogger, ILogger<T>, LoggerMessage, LoggerMessageAttribute, message template, BeginScope, LogLevel, IsEnabled, SkipEnabledCheck, CA2254, CA1848, CA1873, EnableRedaction, AddRedaction, LogProperties, Microsoft.Extensions.Logging, Microsoft.Extensions.Compliance.Redaction, Microsoft.Extensions.Telemetry]
---

# Write Structured Logs with ILogger and Source-Generated Log Methods

`logger.LogInformation($"Order {order.Id} placed")` produces a unique string per call. You can't query by the `OrderId` property, the string is built even when the level is disabled, and value types are boxed. Logging whole objects or request bodies is how PII and secrets usually end up in log storage. Use constant message templates, ideally through `[LoggerMessage]` source-generated methods, and log identifiers instead of payloads.

## Implementation

1. **Inject `ILogger<T>`** through the constructor or a primary constructor.
2. **Declare `partial` log methods with `[LoggerMessage(Level = ..., Message = "...")]`** in a `partial` class. The generator gets the logger from an `ILogger` field, from a primary-constructor parameter (.NET 9+), or from a parameter of a `static` method (often a `this ILogger` extension).
3. **Name placeholders in PascalCase** (`{OrderId}`). They become property names, so use the same name for the same concept everywhere.
4. **Pass exceptions as an `Exception` parameter.** The first one is attached as the log's exception. Don't put `ex.Message` into the template.
5. **Use scopes for context that many lines share:** `logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = id })`. Scopes are emitted only when the provider has `IncludeScopes` on, for example the JSON console or OpenTelemetry.
6. **Set levels per category in configuration** (`Logging:LogLevel`), not in code.
7. **Redact sensitive values** with `Microsoft.Extensions.Compliance.Redaction` and `Microsoft.Extensions.Telemetry`: call `services.AddRedaction(...)` and `builder.Logging.EnableRedaction()`, then put data-classification attributes on log-method parameters.

## Example Code

```csharp
using Microsoft.Extensions.Logging;

namespace Shop.Orders;

public sealed record Order(Guid Id, string CustomerEmail, decimal Total);

public sealed partial class OrderProcessor(ILogger<OrderProcessor> logger)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        // Every log line inside the scope carries OrderId (when the provider includes scopes).
        using IDisposable? scope = logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = order.Id });

        LogProcessingStarted(order.Id, order.Total); // never log order.CustomerEmail or the whole record
        try
        {
            await Task.Delay(10, ct); // real work
            LogProcessingCompleted(order.Id);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            LogProcessingFailed(ex, order.Id);
            throw;
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Processing order {OrderId} with total {OrderTotal}")]
    private partial void LogProcessingStarted(Guid orderId, decimal orderTotal);

    [LoggerMessage(Level = LogLevel.Information, Message = "Processed order {OrderId}")]
    private partial void LogProcessingCompleted(Guid orderId);

    [LoggerMessage(Level = LogLevel.Error, Message = "Failed to process order {OrderId}")]
    private partial void LogProcessingFailed(Exception exception, Guid orderId);
}
```

## Best Practices & Constraints

- **MANDATORY**: Make message templates constants with named placeholders. CA2254 flags templates that aren't constant.
- **MANDATORY**: Never log passwords, tokens, API keys, connection strings, request or response bodies, or personal data in clear text. Log IDs, or redact.
- **DO NOT** use string interpolation or concatenation in `Log*` calls.
- **DO NOT** log whole objects. `Microsoft.Extensions.Logging` calls `ToString()`, and a record's `ToString()` prints every property. Serilog's `{@Obj}` destructuring doesn't apply here. Log selected fields, or use `[LogProperties]` (`Microsoft.Extensions.Telemetry.Abstractions`) together with redaction.
- **DO NOT** log and rethrow in every layer. Log once, where the exception is handled.
- **DO NOT** compute expensive arguments for Debug/Trace logs without a guard. Generated methods check `IsEnabled` for you. Guard hand-written calls yourself (CA1873).
- **DO NOT** create loggers from `ILoggerFactory` in business classes or keep them in static fields.
- Levels: `Trace`/`Debug` for developer diagnostics, off in production. `Information` for meaningful business or lifecycle events, not every loop iteration. `Warning` for unexpected but handled situations (retry, fallback). `Error` when an operation failed. `Critical` when the app is unusable.
- On hot paths, prefer `[LoggerMessage]` over the `LogInformation(...)` extension methods (CA1848), which box values and parse the template on every call. `EventId` is optional, but if you set one it must be unique per class.

## Version notes

- `[LoggerMessage]` generator: .NET 6+. Older targets use `LoggerMessage.Define`.
- Logger from a primary-constructor parameter: .NET 9+. On .NET 8, assign it to a `private readonly ILogger _logger` field.
- CA1873 ships with the .NET 10 SDK analyzers. CA2254 and CA1848 exist in earlier SDKs.
- Redaction (`AddRedaction`, `EnableRedaction`) and `[LogProperties]` came with the 8.0 extensions packages (.NET 8+). `HmacRedactor` is still experimental (`EXTEXP0002`).

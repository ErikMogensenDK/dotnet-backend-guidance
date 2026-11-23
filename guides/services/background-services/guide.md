---
name: background-services
description: Run recurring or queued background work in an ASP.NET Core or worker host that uses scoped services, survives failures and shuts down gracefully.
keywords: [BackgroundService, IHostedService, AddHostedService, ExecuteAsync, stoppingToken, IServiceScopeFactory, CreateAsyncScope, PeriodicTimer, WaitForNextTickAsync, HostOptions, BackgroundServiceExceptionBehavior, ShutdownTimeout, IHostedLifecycleService, Channel, graceful shutdown, Microsoft.Extensions.Hosting]
---

# Run Background Work with BackgroundService

Hosted services are singletons, so a `DbContext` injected into one is a captive dependency. Legacy patterns lose work or hang shutdown: `while (true)` + `Task.Delay` loops that ignore the stopping token, `System.Threading.Timer` callbacks running `async void` code, and `Task.Run` fire-and-forget calls from controllers. Since .NET 6, an unhandled exception in `ExecuteAsync` stops the whole host by default.

## Implementation

1. **Derive from `BackgroundService` and register it with `AddHostedService<T>()`.**
2. **Inject only singletons** (`IServiceScopeFactory`, `TimeProvider`, `IOptions<T>`, `ILogger<T>`). For each unit of work (a tick or a message), create `await using var scope = scopeFactory.CreateAsyncScope()` and resolve scoped services from it.
3. **For recurring work, loop on `PeriodicTimer.WaitForNextTickAsync(stoppingToken)`**, constructed with a `TimeProvider` on .NET 8+. It doesn't overlap ticks or drift the way `Task.Delay` loops do.
4. **Pass `stoppingToken` to every call.** On shutdown it's canceled, and the host waits for `ExecuteAsync` until `HostOptions.ShutdownTimeout` (30 s by default) runs out.
5. **Catch and log exceptions per iteration** so one bad batch doesn't stop the host. Let `OperationCanceledException` from `stoppingToken` end the loop. The host doesn't treat that as an error.
6. **For in-process queues,** consume a bounded `Channel<T>` with `await foreach (var item in reader.ReadAllAsync(stoppingToken))`.

## Example Code

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Shop.Jobs;

public sealed class OutboxOptions
{
    public TimeSpan Interval { get; set; } = TimeSpan.FromSeconds(10);
}

public interface IOutboxProcessor // scoped: uses a DbContext in a real app
{
    Task<int> PublishPendingAsync(CancellationToken ct);
}

public sealed partial class OutboxPublisher(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    IOptions<OutboxOptions> options,
    ILogger<OutboxPublisher> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.Interval, timeProvider);
        do
        {
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOutboxProcessor>();
                int published = await processor.PublishPendingAsync(stoppingToken);
                LogPublished(published);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return; // graceful shutdown
            }
            catch (Exception ex)
            {
                LogBatchFailed(ex); // keep running; next tick retries
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "Published {Count} outbox messages")]
    private partial void LogPublished(int count);

    [LoggerMessage(Level = LogLevel.Error, Message = "Outbox batch failed")]
    private partial void LogBatchFailed(Exception exception);
}

public static class JobRegistration
{
    public static IServiceCollection AddOutboxPublisher<TProcessor>(this IServiceCollection services)
        where TProcessor : class, IOutboxProcessor
    {
        services.AddOptions<OutboxOptions>().BindConfiguration("Outbox");
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<IOutboxProcessor, TProcessor>();
        services.AddHostedService<OutboxPublisher>();
        services.Configure<HostOptions>(o =>
        {
            o.ShutdownTimeout = TimeSpan.FromSeconds(25); // below the orchestrator's kill grace period
            o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.StopHost;
        });
        return services;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Keep `ShutdownTimeout` below the platform's kill grace period. Kubernetes' `terminationGracePeriodSeconds` defaults to 30 s.
- **MANDATORY**: Create one DI scope per unit of work, never one for the service's lifetime, or its `DbContext` grows and goes stale.
- **DO NOT** inject scoped services (`DbContext`, repositories, `IOptionsSnapshot<T>`) into a hosted service constructor.
- **DO NOT** write `while (true)` + `Task.Delay` loops that ignore cancellation, or `Timer` callbacks that run `async void` code.
- **DO NOT** fire-and-forget `Task.Run` from endpoints. The request scope and its `DbContext` get disposed underneath it, exceptions go unobserved, and shutdown doesn't wait. Enqueue to a `Channel<T>` or a durable queue instead.
- **DO NOT** "fix" a crashing worker with `BackgroundServiceExceptionBehavior.Ignore`. That leaves a dead worker in a healthy-looking process. Handle errors inside the loop and let `StopHost` (the default) restart the process.
- **DO NOT** block in `StartAsync`. Put initialization that must finish before startup completes in `StartAsync` or `IHostedLifecycleService.StartingAsync` on purpose.
- Every replica runs every `BackgroundService`. For once-per-cluster jobs, use a distributed lock, leader election or a dedicated worker deployment.
- When you override `StartAsync`/`StopAsync` on `BackgroundService`, call and await `base`.

## Version notes

- `BackgroundService`: .NET Core 2.1+. `CreateAsyncScope` and `PeriodicTimer`: .NET 6+. `PeriodicTimer(TimeSpan, TimeProvider)`: .NET 8+.
- .NET 6: exceptions from `ExecuteAsync` are logged and stop the host (`BackgroundServiceExceptionBehavior.StopHost`). Before .NET 6 they were swallowed. The default `ShutdownTimeout` also rose from 5 s to 30 s.
- `IHostedLifecycleService` and `HostOptions.ServicesStartConcurrently`/`ServicesStopConcurrently`: .NET 8+.
- .NET 10 breaking change: all of `ExecuteAsync` runs on a background thread. Before .NET 10, the synchronous part before the first `await` ran on the startup thread and blocked other services. Move ordering-dependent initialization to `StartAsync`.

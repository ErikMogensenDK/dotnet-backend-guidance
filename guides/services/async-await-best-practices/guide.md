---
name: async-await-best-practices
description: Write correct, scalable asynchronous C# code without deadlocks, thread-pool starvation, lost exceptions or ignored cancellation.
keywords: [async, await, Task, ValueTask, CancellationToken, ConfigureAwait, ConfigureAwaitOptions, Task.WhenAll, Task.WhenEach, Parallel.ForEachAsync, IAsyncEnumerable, EnumeratorCancellation, WithCancellation, SemaphoreSlim, GetAwaiter().GetResult(), sync over async, async void, System.Linq.AsyncEnumerable]
---

# Use async/await Correctly in .NET Backend Code

Blocking on async code with `.Result`, `.Wait()` or `.GetAwaiter().GetResult()` holds a thread-pool thread while it waits. Under load, ASP.NET Core runs out of threads (starvation), and library code called from a UI or legacy context deadlocks. Other common bugs: `async void` methods whose exceptions crash the process, `CancellationToken`s that are accepted but never passed on, and independent I/O awaited one call at a time.

## Implementation

1. **Go async all the way:** return `Task`/`Task<T>` and `await` from the endpoint or `ExecuteAsync` down to the I/O call. Suffix method names with `Async`.
2. **Accept a `CancellationToken` as the last parameter and pass it to every callee.** ASP.NET Core binds `CancellationToken` endpoint parameters to `HttpContext.RequestAborted`.
3. **Run independent work concurrently:** start the tasks, `await Task.WhenAll(...)`, then read each result with `await`. For bounded parallelism, use `Parallel.ForEachAsync(items, new ParallelOptions { MaxDegreeOfParallelism = n, CancellationToken = ct }, ...)`.
4. **Stream large results as `IAsyncEnumerable<T>`.** Put `[EnumeratorCancellation]` on the iterator's token parameter, and consume with `await foreach` (plus `.WithCancellation(ct)` when you didn't pass the token in).
5. **Return `ValueTask<T>` only when results are usually available synchronously,** for example on a cache hit. Otherwise use `Task<T>`.
6. **Use `ConfigureAwait(false)` on every await in reusable libraries.** ASP.NET Core app code has no `SynchronizationContext` and doesn't need it.
7. **Guard shared state across awaits with `SemaphoreSlim.WaitAsync`.** You can't `await` inside `lock`.

## Example Code

```csharp
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;

namespace Shop.Dashboard;

public sealed record DashboardDto(int OpenOrders, decimal RevenueToday, IReadOnlyList<string> Alerts);

public interface IOrderStats // implementations must not share one DbContext (not thread-safe)
{
    Task<int> CountOpenAsync(CancellationToken ct);
    Task<decimal> RevenueTodayAsync(CancellationToken ct);
}

public interface IAlertFeed
{
    IAsyncEnumerable<string> ReadAsync(CancellationToken ct);
}

public interface IRateSource
{
    Task<decimal> FetchRateAsync(string currency, CancellationToken ct);
}

public sealed class DashboardService(IOrderStats stats, IAlertFeed alerts)
{
    public async Task<DashboardDto> GetAsync(CancellationToken ct)
    {
        // Independent I/O: start both, then await together.
        Task<int> openTask = stats.CountOpenAsync(ct);
        Task<decimal> revenueTask = stats.RevenueTodayAsync(ct);
        await Task.WhenAll(openTask, revenueTask);

        var latest = new List<string>();
        await foreach (string alert in alerts.ReadAsync(ct))
        {
            latest.Add(alert);
            if (latest.Count == 10) break; // disposes the enumerator, stopping the producer
        }

        return new DashboardDto(await openTask, await revenueTask, latest);
    }

    public async IAsyncEnumerable<string> StreamCriticalAlertsAsync(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        await foreach (string alert in alerts.ReadAsync(ct))
        {
            if (alert.StartsWith("CRITICAL", StringComparison.Ordinal)) yield return alert;
        }
    }
}

public sealed class ExchangeRateCache(IRateSource source)
{
    private readonly ConcurrentDictionary<string, decimal> _rates = new();

    // ValueTask: most calls complete synchronously from the dictionary.
    public ValueTask<decimal> GetRateAsync(string currency, CancellationToken ct) =>
        _rates.TryGetValue(currency, out decimal rate)
            ? ValueTask.FromResult(rate)
            : new ValueTask<decimal>(LoadAsync(currency, ct));

    private async Task<decimal> LoadAsync(string currency, CancellationToken ct)
    {
        decimal rate = await source.FetchRateAsync(currency, ct);
        _rates[currency] = rate;
        return rate;
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Pass the received `CancellationToken` to every async call (EF Core, `HttpClient`, `Task.Delay`). Let `OperationCanceledException` propagate instead of turning it into a normal result.
- **MANDATORY**: Await every `Task`, or hand it to something that observes it, such as a `Channel` consumer.
- **DO NOT** block with `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` or `Task.WaitAll` in request paths or hosted services.
- **DO NOT** write `async void` except for event handlers. Its exceptions crash the process. Async lambdas passed to `Action` parameters silently become `async void`.
- **DO NOT** wrap work in `Task.Run` in ASP.NET Core to "make it async". It just uses another pool thread.
- **DO NOT** run concurrent operations (`WhenAll`, `Parallel.ForEachAsync`) on one `DbContext` or any other non-thread-safe object.
- **DO NOT** await a `ValueTask` twice, await it concurrently, or read `.Result` before it completes. Call `.AsTask()` once if you need to.
- **DO NOT** elide `async`/`await` (returning the task directly) in methods that have `using`, `try` or code after the call. The resource is disposed too early.
- **DO NOT** add `ConfigureAwait(false)` throughout ASP.NET Core app code, and don't leave it out of packaged libraries.
- For per-operation timeouts, use `CancellationTokenSource.CreateLinkedTokenSource(ct)` + `CancelAfter`, and dispose the source.

## Version notes

- `ValueTask`: .NET Core 2.0+. `IAsyncEnumerable<T>`/`await foreach`: C# 8 / .NET Core 3.0+.
- `Parallel.ForEachAsync`: .NET 6+. `ConfigureAwait(ConfigureAwaitOptions)` and `CancellationTokenSource.CancelAsync()`: .NET 8+.
- `Task.WhenEach` (`await foreach` over tasks as they complete): .NET 9+. Earlier versions loop with `Task.WhenAny`.
- .NET 10 has LINQ for `IAsyncEnumerable<T>` built in (`System.Linq.AsyncEnumerable`). Remove the community `System.Linq.Async` package or update it to v7 to avoid ambiguous-call errors. Older targets can use the `System.Linq.AsyncEnumerable` NuGet package.

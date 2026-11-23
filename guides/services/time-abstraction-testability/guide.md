---
name: time-abstraction-testability
description: Make code that depends on the current time, delays, timeouts or timers deterministic and unit-testable without sleeping in tests.
keywords: [TimeProvider, TimeProvider.System, GetUtcNow, GetLocalNow, GetTimestamp, GetElapsedTime, CreateTimer, ITimer, FakeTimeProvider, Advance, SetUtcNow, AutoAdvanceAmount, Microsoft.Extensions.TimeProvider.Testing, Microsoft.Bcl.TimeProvider, Task.Delay, PeriodicTimer, CancellationTokenSource, DateTimeOffset, DateTime.Now, ISystemClock]
---

# Abstract Time with TimeProvider and Test It with FakeTimeProvider

Business logic that calls `DateTime.Now`, `DateTime.UtcNow` or `DateTimeOffset.UtcNow`, or that waits with `Task.Delay(TimeSpan)`, can't be tested deterministically. Its tests either sleep for real or turn flaky at midnight, at month ends and at DST changes. Many codebases invented `IClock`/`IDateTimeProvider` wrappers or used `ISystemClock`. Since .NET 8, the BCL provides `System.TimeProvider`, framework APIs accept it, and `FakeTimeProvider` controls it in tests.

## Implementation

1. **Register `services.AddSingleton(TimeProvider.System)`** and inject `TimeProvider` wherever code needs "now", a delay, a timeout or a timer.
2. **Read time with `GetUtcNow()`** (a UTC `DateTimeOffset`). Measure durations that drive logic with `GetTimestamp()` and `GetElapsedTime(start)` instead of `Stopwatch`.
3. **Pass the provider to time-aware APIs:**
   - `Task.Delay(delay, timeProvider, ct)`
   - `task.WaitAsync(timeout, timeProvider, ct)`
   - `new CancellationTokenSource(delay, timeProvider)`
   - `new PeriodicTimer(period, timeProvider)`
   - `timeProvider.CreateTimer(...)`, which returns an `ITimer` that you dispose
4. **In tests, use `FakeTimeProvider`** from `Microsoft.Extensions.TimeProvider.Testing`: `new FakeTimeProvider(start)`, then `Advance(TimeSpan)` or `SetUtcNow(...)`. Advancing fires due timers and delays synchronously. The default start is 2000-01-01 00:00 UTC.
5. **In integration tests, replace the registration** with `services.AddSingleton<TimeProvider>(fake)`, for example in `WebApplicationFactory.ConfigureTestServices`.
6. **Store and compute instants in UTC.** Convert to a user's zone only for display with `TimeZoneInfo.ConvertTime(utc, TimeZoneInfo.FindSystemTimeZoneById("Europe/Copenhagen"))`. Use `DateOnly` for calendar dates.

## Example Code

```csharp
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Shop.Billing;

public sealed record Trial(Guid CustomerId, DateTimeOffset StartedAt, TimeSpan Length)
{
    public DateTimeOffset EndsAt => StartedAt + Length;
}

public sealed class TrialService(TimeProvider time)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public Trial Start(Guid customerId) => new(customerId, time.GetUtcNow(), TrialLength);

    public bool IsActive(Trial trial) => time.GetUtcNow() < trial.EndsAt;

    public async Task<bool> RemindAfterAsync(TimeSpan delay, CancellationToken ct)
    {
        await Task.Delay(delay, time, ct); // honours FakeTimeProvider in tests
        return true;
    }
}

public sealed class TrialServiceTests
{
    [Fact]
    public void Trial_expires_exactly_after_14_days()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 29, 0, 30, 0, TimeSpan.Zero)); // DST weekend
        var sut = new TrialService(time);
        Trial trial = sut.Start(Guid.NewGuid());

        time.Advance(TimeSpan.FromDays(14) - TimeSpan.FromTicks(1));
        Assert.True(sut.IsActive(trial));

        time.Advance(TimeSpan.FromTicks(1));
        Assert.False(sut.IsActive(trial));
    }

    [Fact]
    public async Task Reminder_fires_after_delay_without_waiting()
    {
        var time = new FakeTimeProvider();
        var sut = new TrialService(time);

        Task<bool> reminder = sut.RemindAfterAsync(TimeSpan.FromHours(1), CancellationToken.None);
        Assert.False(reminder.IsCompleted);

        time.Advance(TimeSpan.FromHours(1)); // completes the delay synchronously
        Assert.True(await reminder);
    }
}
```

## Best Practices & Constraints

- **MANDATORY**: Inject `TimeProvider` into every class whose behavior depends on the current or elapsed time.
- **MANDATORY**: Persist and compare instants in UTC, preferably as `DateTimeOffset`.
- **DO NOT** call `DateTime.Now`, `DateTime.UtcNow`, `DateTimeOffset.UtcNow` or `DateTime.Today` in business logic. Framework internals such as log timestamps are fine.
- **DO NOT** base business rules on server local time (`DateTime.Now`, `GetLocalNow()`). It's meaningless in containers and shifts with DST.
- **DO NOT** add custom `IClock` interfaces or use `Microsoft.AspNetCore.Authentication.ISystemClock` (obsolete since .NET 8: "Use TimeProvider instead") or `Microsoft.Extensions.Internal.ISystemClock`.
- **DO NOT** use `Thread.Sleep` or real delays in tests. Advance a `FakeTimeProvider` instead.
- **DO NOT** use `Task.Delay(TimeSpan)` or `new CancellationTokenSource(TimeSpan)` without the provider in code you want to test. Those always use real time.
- `Advance` only fires timers that already exist. If the code under test hasn't reached `Task.Delay` yet, the delay stays pending forever, so assert `!task.IsCompleted` before advancing.
- `AutoAdvanceAmount` moves time forward on every `GetUtcNow()`. Leave it at zero for exact assertions. Dispose timers created from the provider.

## Version notes

- `TimeProvider`, `ITimer` and the provider overloads of `Task.Delay`, `WaitAsync`, `CancellationTokenSource` and `PeriodicTimer`: .NET 8+.
- .NET 5–7, .NET Standard 2.0 and .NET Framework 4.6.2+ get `TimeProvider` from `Microsoft.Bcl.TimeProvider`, which uses extension methods instead: `timeProvider.Delay(...)`, `task.WaitAsync(timeout, timeProvider)` and `timeProvider.CreateCancellationTokenSource(delay)`.
- `FakeTimeProvider` (namespace `Microsoft.Extensions.Time.Testing`): `Microsoft.Extensions.TimeProvider.Testing` 8.0+.
- `DateOnly`/`TimeOnly` and cross-platform IANA time-zone IDs: .NET 6+.

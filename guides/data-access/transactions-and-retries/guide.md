---
name: transactions-and-retries
description: Make multi-step database writes atomic and survive transient database failures with EF Core transactions and connection resiliency.
keywords: [BeginTransactionAsync, CommitAsync, SaveChangesAsync, EnableRetryOnFailure, CreateExecutionStrategy, ExecuteAsync, ExecuteInTransactionAsync, IExecutionStrategy, SqlServerRetryingExecutionStrategy, "does not support user-initiated transactions", CreateSavepointAsync, TransactionScope, ChangeTracker.Clear]
---

# Transactions and Retries

`SaveChangesAsync` already wraps all of its pending inserts, updates and deletes in one transaction. Wrapping a single `SaveChanges` in `BeginTransactionAsync` adds nothing but an extra round trip. Explicit transactions are needed only when one unit of work spans **several** `SaveChanges` calls, `ExecuteUpdate`/`ExecuteDelete` calls, or raw SQL commands. Cloud databases drop connections transiently, so enable the provider's retrying execution strategy (`EnableRetryOnFailure`). Once retries are on, a user transaction must run inside `Database.CreateExecutionStrategy().ExecuteAsync(...)`. Otherwise EF throws *"The configured execution strategy ... does not support user-initiated transactions"*, because it can't replay half a transaction.

## Implementation

1. Enable retries in the provider options: `UseSqlServer(cs, o => o.EnableRetryOnFailure())` or `UseNpgsql(cs, o => o.EnableRetryOnFailure())`. Optional arguments set the maximum retry count and delay. Each query and each `SaveChangesAsync` then retries as a unit.
2. For one logical change, make all modifications and call `SaveChangesAsync` **once**. No explicit transaction is needed.
3. For multi-step work, get the strategy with `var strategy = db.Database.CreateExecutionStrategy();`, then put the **entire** unit inside `await strategy.ExecuteAsync(async ct => { ... }, ct)`: begin the transaction, do every step, and call `CommitAsync`.
4. The delegate may run more than once. Make it self-contained. Do the reads inside it, and start with a clean change tracker (`db.ChangeTracker.Clear()`) or a fresh context from `IDbContextFactory<T>`, so a retry doesn't re-send entities left over from the failed attempt. Don't perform non-database side effects (emails, HTTP calls, publishing messages) inside it. Use an outbox table in the same transaction instead.
5. If a connection drop *during commit* would cause duplicates (for example, inserting rows with generated keys), use `strategy.ExecuteInTransactionAsync(db, operation, verifySucceeded, ct)` with `SaveChangesAsync(acceptAllChangesOnSuccess: false)`, then call `db.ChangeTracker.AcceptAllChanges()` once it succeeds.
6. Inside a user transaction, EF creates a savepoint before each `SaveChanges` and rolls back to it on failure. You can also call `CreateSavepointAsync`/`RollbackToSavepointAsync` yourself. Savepoints are not created on SQL Server when MARS is enabled.

## Example Code

```csharp
using Microsoft.EntityFrameworkCore;

namespace Shop.Checkout;

public sealed class CheckoutService(ShopDbContext db)
{
    public Task<int> PlaceOrderAsync(int cartId, CancellationToken ct)
    {
        var strategy = db.Database.CreateExecutionStrategy();

        // The whole delegate is the retriable unit; it may run more than once.
        return strategy.ExecuteAsync(async cancellationToken =>
        {
            db.ChangeTracker.Clear();   // discard state from a failed previous attempt

            await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);

            var cart = await db.Carts.Include(c => c.Items)
                .SingleAsync(c => c.Id == cartId, cancellationToken);

            var order = new Order { CustomerId = cart.CustomerId, Total = cart.Items.Sum(i => i.Price * i.Quantity) };
            db.Orders.Add(order);
            await db.SaveChangesAsync(cancellationToken);   // first SaveChanges: generates order.Id

            db.OutboxMessages.Add(new OutboxMessage { Type = "OrderPlaced", Payload = $$"""{"orderId":{{order.Id}}}""" });
            await db.SaveChangesAsync(cancellationToken);   // second SaveChanges, same transaction

            await db.CartItems.Where(i => i.CartId == cartId).ExecuteDeleteAsync(cancellationToken);

            await tx.CommitAsync(cancellationToken);
            return order.Id;
        }, ct);
    }
}

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Cart> Carts => Set<Cart>();
    public DbSet<CartItem> CartItems => Set<CartItem>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();
}

// Registration (Program.cs):
// builder.Services.AddDbContext<ShopDbContext>(o => o.UseSqlServer(cs, sql => sql.EnableRetryOnFailure(
//     maxRetryCount: 5, maxRetryDelay: TimeSpan.FromSeconds(10), errorNumbersToAdd: null)));

public sealed class Cart { public int Id { get; set; } public int CustomerId { get; set; } public List<CartItem> Items { get; } = []; }
public sealed class CartItem { public int Id { get; set; } public int CartId { get; set; } public decimal Price { get; set; } public int Quantity { get; set; } }
public sealed class Order { public int Id { get; set; } public int CustomerId { get; set; } public decimal Total { get; set; } }
public sealed class OutboxMessage { public long Id { get; set; } public required string Type { get; set; } public required string Payload { get; set; } }
```

## Best Practices & Constraints

- **MANDATORY**: Enable `EnableRetryOnFailure()` for Azure SQL, cloud PostgreSQL, and any database reached over an unreliable network.
- **MANDATORY**: When retries are enabled, put every `BeginTransactionAsync` (and `TransactionScope`) inside `CreateExecutionStrategy().ExecuteAsync`, and do all the work for that transaction inside the delegate.
- **MANDATORY**: Keep transactions short. Load data, write, and commit. Never await user input, HTTP calls or queues while a transaction is open.
- **DO NOT** wrap a single `SaveChangesAsync` in `BeginTransactionAsync`. It's already atomic.
- **DO NOT** call `SaveChangesAsync` per entity inside a transaction "to get IDs". Add the related entities through navigations and save once. EF orders the inserts and fixes up foreign keys.
- **DO NOT** write your own Polly retry loop around `SaveChangesAsync`, and don't catch `SqlException`/`NpgsqlException` to retry by hand. Use the execution strategy, which knows which errors are transient.
- **DO NOT** reuse the tracked entities of a failed attempt on retry, or begin the transaction outside the strategy delegate.
- **DO NOT** wrap `Database.MigrateAsync()` in your own transaction or execution strategy on EF Core 9+. It manages both itself.

## Version notes

- `EnableRetryOnFailure` and `CreateExecutionStrategy` have been available since EF Core 1.x/2.x. The `ExecuteAsync` overload that takes a `CancellationToken` and `ExecuteInTransactionAsync` are available in all supported versions.
- Automatic savepoints in `SaveChanges`, and the `CreateSavepointAsync`/`RollbackToSavepointAsync` APIs: **EF Core 5.0+**.
- `ChangeTracker.Clear()`: **EF Core 5.0+**. On older versions, create a new context inside the delegate.
- `Database.AutoTransactionBehavior` (`WhenNeeded`/`Always`/`Never`): **EF Core 7.0+**. It replaced `AutoTransactionsEnabled`.
- **EF Core 9**: `MigrateAsync` runs inside its own execution strategy and transaction and throws `MigrationsUserTransactionWarning` if you wrap it.

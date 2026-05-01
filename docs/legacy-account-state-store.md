# Legacy Lightweight AccountStateStore

`AccountStateStore` is the original lightweight cache API. It remains available
from the package root.

Use it when you want a simple in-memory object for balances, positions, orders,
leverage, and custom per-symbol metadata, and you are comfortable applying all
exchange reconciliation rules yourself.

For new REST-plus-WebSocket exchange integrations, prefer
`ExchangeAccountStateStore`.

## Which Store Should I Use?

Use `ExchangeAccountStateStore` when:

- you set account state from REST snapshots
- you apply private account-data updates
- you need a `readyToTrade` signal
- you want state checks after reconnects or stream gaps
- you want hedge-mode-safe position identity
- you want exchange adapter support

Use `AccountStateStore` when:

- you want a lightweight cache with direct setters/getters
- your app already owns all reconciliation rules
- you rely on existing metadata persistence helpers
- you are maintaining an existing integration

## Basic Legacy Usage

```typescript
import { AccountStateStore } from 'accountstate';

const accountState = new AccountStateStore();

accountState.setWalletBalance(10000);
accountState.upsertActiveOrder(order);
accountState.setActivePosition('BTCUSDT', 'LONG', position);

const activeOrders = accountState.getActiveOrders();
const position = accountState.getActivePosition('BTCUSDT', 'LONG');
```

## Metadata Persistence

The legacy store supports custom per-symbol metadata:

```typescript
interface PositionMetadata {
  entryCount: number;
  lifecycleId: string;
}

const accountState = new AccountStateStore<PositionMetadata>();

accountState.setSymbolMetadata('BTCUSDT', {
  entryCount: 1,
  lifecycleId: 'epoch-1',
});

if (accountState.isPendingPersist()) {
  await persist(accountState.getAllSymbolMetadata());
  accountState.setIsPendingPersist(false);
}
```

## Migration Notes

The two stores use different models:

- `AccountStateStore` is a direct cache.
- `ExchangeAccountStateStore` is an exchange account reducer.

When migrating, start by replacing your current REST bootstrap with:

```typescript
state.setPositions(scope, positions);
state.setOpenOrders(scope, openOrders);
state.setBalances(scope, balances);
```

Then replace private account-data stream handlers with:

```typescript
state.applyPositionUpdate(scope, position);
state.applyOrderUpdate(scope, order);
state.applyBalanceUpdate(scope, balance);
```

Finally, read state through `getAccount(scope)` and handle any `stateChecks`
before allowing planner logic to trade.

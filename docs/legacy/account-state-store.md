# Legacy Lightweight AccountStateStore

`AccountStateStore` is the original lightweight cache API. It remains available
from the package root for backwards compatibility, but it is deprecated for new
exchange integrations.

Use it when you want a simple in-memory object for balances, positions, orders,
leverage, and custom per-symbol metadata, and you are comfortable applying all
exchange reconciliation rules yourself.

For new REST-plus-WebSocket exchange integrations, prefer
`ExchangeAccountStateStore`.

## Which Store Should I Use?

Use `ExchangeAccountStateStore` when:

- you set account state from REST snapshots
- you apply private WebSocket updates
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

## Balance Management

```typescript
accountState.setWalletBalance(10000);
const balance = accountState.getWalletBalance();

accountState.storePreviousBalance();
accountState.setWalletBalance(10500);
const previousBalance = accountState.getPreviousBalance();
```

## Position Management

```typescript
const hasPosition = accountState.isSymbolInAnyPosition('BTCUSDT');
const hasLongPosition = accountState.isSymbolSideInPosition('BTCUSDT', 'LONG');

const longPosition = accountState.getActivePosition('BTCUSDT', 'LONG');
const allPositions = accountState.getAllPositions();
const { total, totalHedged } = accountState.getTotalActivePositions();

accountState.deleteActivePosition('BTCUSDT', 'LONG');
```

## Order Management

```typescript
const allOrders = accountState.getOrders();
const activeOrders = accountState.getActiveOrders();

const btcOrders = accountState.getOrdersForSymbol('BTCUSDT');
const btcBuyOrders = accountState.getOrdersForSymbolSide('BTCUSDT', 'BUY');

const order = accountState.getOrder('12345');
const newOrders = accountState.getOrdersByStatus('NEW');
const ordersByPrice = accountState.getOrdersSortedByPrice(true);

accountState.clearAllOrders();
```

## Leverage Management

```typescript
accountState.setSymbolLeverage('BTCUSDT', 10);

const leverage = accountState.getSymbolLeverage('BTCUSDT');
const allLeverage = accountState.getSymbolLeverageCache();
```

## Price Updates And PnL

```typescript
accountState.processPriceEvent({
  symbol: 'BTCUSDT',
  price: 46000,
  timestamp: Date.now(),
});

const summary = accountState.getSessionSummary(startingBalance);

console.log('Realized PnL:', summary.account.pnlState.realisedPnl);
console.log('Unrealized PnL:', summary.account.pnlState.unrealisedPnl);
```

## Custom Metadata

The legacy store supports custom per-symbol metadata. This is project-owned
state that an exchange usually does not know about, such as entry counters,
trailing-stop state, or the last close price for a symbol.

```typescript
interface MyPositionMetadata {
  leaderId: string;
  entryCount: number;
  lastEntryPrice: number;
  strategy: string;
}

const accountState = new AccountStateStore<MyPositionMetadata>();

accountState.setSymbolMetadata('BTCUSDT', {
  leaderId: 'trader-123',
  entryCount: 3,
  lastEntryPrice: 45000,
  strategy: 'DCA',
});

const metadata = accountState.getSymbolMetadata('BTCUSDT');

accountState.setSymbolMetadataValue('BTCUSDT', 'entryCount', 4);

const symbolsWithMetadata = accountState.getSymbolsWithMetadata();

accountState.deletePositionMetadata('BTCUSDT');
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

Most exchange account state can be fetched from REST again after restart. Custom
metadata is different: if your project owns it, your project also needs to
persist it.

`AccountStateStore` sets `isPendingPersist()` to `true` when metadata changes.
One common pattern is to debounce persistence, write `getAllSymbolMetadata()` to
your own storage layer, then call `setIsPendingPersist(false)` after a
successful write:

```typescript
const PERSIST_ACCOUNT_POSITION_METADATA_EVERY_MS = 250;

interface EnginePositionMetadata {
  leaderId: string;
  leaderName: string;
  entryCountLong: number;
  entryCountShort: number;
}

interface PositionMetadataStore {
  read(
    accountId: string,
  ): Promise<Record<string, EnginePositionMetadata> | undefined>;
  write(
    accountId: string,
    data: Record<string, EnginePositionMetadata>,
  ): Promise<void>;
}

class PersistedAccountStateStore extends AccountStateStore<EnginePositionMetadata> {
  #didRestorePositionMetadata = false;

  constructor(
    private readonly accountId: string,
    private readonly storage: PositionMetadataStore,
  ) {
    super();
    this.startPersistPositionMetadataTimer();
  }

  async restorePersistedData(): Promise<void> {
    const metadata = await this.storage.read(this.accountId);

    if (metadata) {
      this.setAllSymbolMetadata(metadata);
    }

    this.#didRestorePositionMetadata = true;
  }

  private startPersistPositionMetadataTimer(): void {
    setInterval(async () => {
      if (!this.#didRestorePositionMetadata) {
        await this.restorePersistedData();
      }

      if (!this.isPendingPersist()) {
        return;
      }

      await this.storage.write(this.accountId, this.getAllSymbolMetadata());
      this.setIsPendingPersist(false);
    }, PERSIST_ACCOUNT_POSITION_METADATA_EVERY_MS);
  }
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

Then replace private WebSocket update handlers with:

```typescript
state.applyPositionUpdate(scope, position);
state.applyOrderUpdate(scope, order);
state.applyBalanceUpdate(scope, balance);
```

Finally, read state through `getAccount(scope)` and handle any `stateChecks`
before allowing planner logic to trade.

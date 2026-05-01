# Exchange Account State Store

`ExchangeAccountStateStore` is the recommended API for new exchange
integrations. It is an in-memory account state store for applications that
already talk to exchange REST APIs and private WebSocket streams.

The store does not create clients, read API keys, reconnect sockets, retry REST
calls, or schedule background work. Your app owns those concerns. The store owns
the account-state rules.

## Normal Workflow

Most applications should use this shape:

```typescript
import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'mainnet',
};

const state = new ExchangeAccountStateStore();

state.syncPositions(scope, normalizedPositionsFromRest);
state.syncOpenOrders(scope, normalizedOpenOrdersFromRest);
state.syncBalances(scope, normalizedBalancesFromRest);

state.onPositionUpdate(scope, normalizedPositionFromStream);
state.onOrderUpdate(scope, normalizedOrderFromStream);
state.onBalanceUpdate(scope, normalizedBalanceFromStream);

const account = state.getAccount(scope);
```

`getAccount(scope)` is the main account view for application code. It contains:

- `positions`
- `openOrders`
- `balances`
- `fills`
- `readyToTrade`
- `syncRequests`
- trust flags such as `canTrustPositions`

Positions, open orders, and balances must be trusted before `readyToTrade` is
true. Fills are background sync by default. Use
`getAccount(scope, { requireFills: true })` when trading decisions require
current fills.

For workflows that use a smaller data set, pass `requiredSubjects`:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders'],
});
```

`readyToTrade` is then evaluated against those subjects. Other unknown subjects
can still appear in `syncRequests` for background refresh.

## REST Snapshots

REST-style methods replace the covered state:

```typescript
state.syncPositions(scope, positions);
state.syncOpenOrders(scope, openOrders);
state.syncBalances(scope, balances);
state.syncFills(scope, fills);
```

Default behavior:

- positions replace the covered position set
- open orders replace the covered open-order set
- balances replace the covered balance set
- fills upsert by identity

Use `coverage` when a REST response only covers part of the account:

```typescript
state.syncOpenOrders(scope, btcOrders, {
  mode: 'replace-symbols',
  coverage: {
    symbols: ['BTCUSDT'],
    orderKinds: ['regular'],
  },
});
```

That prevents a symbol-specific regular-order response from deleting Algo,
conditional, or unrelated-symbol orders.

## Private Stream Updates

Use stream update methods for individual account changes:

```typescript
state.onOrderUpdate(scope, order);
state.onPositionUpdate(scope, position);
state.onBalanceUpdate(scope, balance);
state.onFill(scope, fill);
```

When the private stream reconnects or has a known gap, tell the store:

```typescript
state.streamReconnected(scope, { reason: 'private stream reconnected' });
state.streamGap(scope, { reason: 'missed sequence' });
```

The account will expose `syncRequests` so your app can query the missing REST
state and feed it back into the matching sync method.

## Querying State

```typescript
const account = state.getAccount(scope);
const positions = state.getPositions(scope, { symbol: 'BTCUSDT' });
const position = state.getPosition(scope, {
  symbol: 'BTCUSDT',
  exchangePositionSide: 'LONG',
});
const openOrders = state.getOpenOrders(scope, { symbol: 'BTCUSDT' });
const order = state.getOrder(scope, { customClientOrderId: 'client-1' });
const balance = state.getBalance(scope, 'USDT');
```

`getPosition()` returns `undefined` instead of guessing when the identity is
ambiguous. In hedge mode, pass `exchangePositionSide`.

## Order Submission Outcomes

After submitting an order, record the outcome you know:

```typescript
state.orderAccepted({
  scope,
  intentId: 'intent-1',
  clientOrderId: 'client-1',
  order: provisionalOrder,
});

state.orderRejected({
  scope,
  intentId: 'intent-2',
  clientOrderId: 'client-2',
  error: {
    message: 'Insufficient margin',
    retryable: false,
  },
});

state.orderStatusUnknown({
  scope,
  intentId: 'intent-3',
  clientOrderId: 'client-3',
  error: {
    message: 'Request timed out',
    retryable: true,
  },
});
```

For cancel or unknown-order responses:

```typescript
state.orderCancelled({
  scope,
  identity: { customClientOrderId: 'client-1' },
});

state.orderNotFound({
  scope,
  identity: { exchangeOrderId: '1001' },
});
```

## Change Sets

Every write method returns a `ChangeSet`:

```typescript
const change = state.syncOpenOrders(scope, openOrders);

if (change.changedSubjects.includes('openOrders')) {
  schedulePlannerPass();
}
```

The counters are deliberately broad account-state words:

- `itemsAdded`
- `itemsUpdated`
- `itemsRemoved`
- `itemsMarkedStale`

`changedSubjects` identifies the account-state areas affected by the write:

- `positions`
- `openOrders`
- `balances`
- `fills`
- `lifecycles`
- `sync`

`positions`, `openOrders`, and `lifecycles` are usually the subjects that
trigger trading logic. `sync` covers readiness, confidence, watermark, and
sync-request changes.

## Advanced APIs

Most application code should not need these:

- `ingest()`
- `getAccountView()`
- `getSyncRequests()`
- `accountstate/core`

They exist for exchange adapters, replay tools, conformance fixtures, and
debugging lower-level state transitions.

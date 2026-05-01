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

state.setPositions(scope, normalizedPositionsFromRest);
state.setOpenOrders(scope, normalizedOpenOrdersFromRest);
state.setBalances(scope, normalizedBalancesFromRest);

state.applyPositionUpdate(scope, normalizedPositionFromStream);
state.applyOrderUpdate(scope, normalizedOrderFromStream);
state.applyBalanceUpdate(scope, normalizedBalanceFromStream);

const account = state.getAccount(scope);
```

`getAccount(scope)` is the main account view for application code. It contains:

- `positions`
- `openOrders`
- `balances`
- `fills`
- `readyToTrade`
- `stateChecks`
- trust flags such as `canTrustPositions`

Positions, open orders, and balances must be trusted before `readyToTrade` is
true. Fills are refreshed in the background by default. Use
`getAccount(scope, { requireFills: true })` when trading decisions require
current fills.

For workflows that use a smaller data set, pass `requiredSubjects`:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders'],
});
```

`readyToTrade` is then evaluated against those subjects. Other unknown subjects
can still appear in `stateChecks` for background refresh.

## REST Snapshots

Current-state setters replace the covered state:

```typescript
state.setPositions(scope, positions);
state.setOpenOrders(scope, openOrders);
state.setBalances(scope, balances);
state.setFills(scope, fills);
```

Default behavior:

- positions replace the covered position set
- open orders replace the covered open-order set
- balances replace the covered balance set
- fills upsert by identity

Use `coverage` when a REST response only covers part of the account:

```typescript
state.setOpenOrders(scope, btcOrders, {
  mode: 'replace-symbols',
  coverage: {
    symbols: ['BTCUSDT'],
    orderKinds: ['regular'],
  },
});
```

That prevents a symbol-specific regular-order response from deleting Algo,
conditional, or unrelated-symbol orders.

## Private Account-Data Updates

Use `apply*` methods for individual account changes received from private
account-data streams:

```typescript
state.applyOrderUpdate(scope, order);
state.applyPositionUpdate(scope, position);
state.applyBalanceUpdate(scope, balance);
state.applyFill(scope, fill);
```

When the private account-data stream reconnects or has a known gap, tell the
store:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'account-data stream reconnected',
});
state.recordStreamGap(scope, { reason: 'missed sequence' });
```

The account will expose `stateChecks` so your app can verify the relevant REST
state and feed it back into the matching setter.

## Querying State

```typescript
const account = state.getAccount(scope);
const positions = state.getPositions(scope, { symbol: 'BTCUSDT' });
const position = state.getPosition(scope, {
  symbol: 'BTCUSDT',
  exchangePositionSide: 'LONG',
});
const openOrders = state.getOpenOrders(scope, { symbol: 'BTCUSDT' });
const order = state.getOrder(scope, { customOrderId: 'order-1' });
const balance = state.getBalance(scope, 'USDT');
```

`getPosition()` returns `undefined` instead of guessing when the identity is
ambiguous. In hedge mode, pass `exchangePositionSide`.

## Order Submission Outcomes

After submitting an order, record the outcome you know:

```typescript
state.recordOrderAccepted({
  scope,
  intentId: 'intent-1',
  customOrderId: 'order-1',
  order: provisionalOrder,
});

state.recordOrderRejected({
  scope,
  intentId: 'intent-2',
  customOrderId: 'order-2',
  error: {
    message: 'Insufficient margin',
    retryable: false,
  },
});

state.recordOrderStatusUnknown({
  scope,
  intentId: 'intent-3',
  customOrderId: 'order-3',
  error: {
    message: 'Request timed out',
    retryable: true,
  },
});
```

For cancel or unknown-order responses:

```typescript
state.recordOrderCancelled({
  scope,
  identity: { customOrderId: 'order-1' },
});

state.recordOrderNotFound({
  scope,
  identity: { exchangeOrderId: '1001' },
});
```

## Change Sets

Every write method returns a `ChangeSet`:

```typescript
const change = state.setOpenOrders(scope, openOrders);

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
- `stateChecks`

`positions`, `openOrders`, and `lifecycles` are usually the subjects that
trigger trading logic. `stateChecks` covers readiness, confidence, watermark,
and state-check changes.

## Advanced APIs

Most application code should not need these:

- `ingest()`
- `getAccountView()`
- `getStateChecks()`
- `accountstate/core`

They exist for exchange adapters, replay tools, conformance fixtures, and
debugging lower-level state transitions.

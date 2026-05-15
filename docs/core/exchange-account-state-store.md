# Exchange Account State Store

`ExchangeAccountStateStore` is the recommended API for new exchange
integrations. It is an in-memory account state store for applications that
already talk to exchange REST APIs and private WebSocket account streams.

The store does not create clients, read API keys, reconnect sockets, retry REST
calls, or schedule background work. Your app owns those concerns. The store owns
the account-state rules.

## Normal Workflow

Most applications should use this flow:

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

## Private WebSocket Updates

Use `apply*` methods for individual account changes received from private
WebSocket account streams:

```typescript
state.applyOrderUpdate(scope, order);
state.applyPositionUpdate(scope, position);
state.applyBalanceUpdate(scope, balance);
state.applyFill(scope, fill);
```

When the private WebSocket stream reconnects or has a known gap,
tell the store:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'private WebSocket stream reconnected',
});
state.recordStreamGap(scope, { reason: 'missed sequence' });
```

The account will expose `stateChecks` so your app can verify the relevant REST
state and feed it back into the matching setter.

When using an exchange adapter, the normal private event path is:

```typescript
state.ingest(exchange.ws.privateEvent(scope, event));

for (const route of exchange.ws.routePrivateEvent(event)) {
  applyRouteToYourWorkflow(route);
}
```

The first call updates the store. The route decisions are read-only hints for
your application and keep row-level meanings separate: active orders, terminal
orders, fills, positions, and balances. See
[Private event routing](./private-event-routing.md).

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
const targetStillOpen = state.hasOpenOrderIdentity(scope, {
  customOrderId: 'order-1',
});
const balance = state.getBalance(scope, 'USDT');
```

`getPosition()` returns `undefined` instead of guessing when the identity is
ambiguous. In hedge mode, pass `exchangePositionSide`.

Open-order reads default to trusted exchange-confirmed rows. Locally accepted
submissions are kept as provisional rows until REST or private WebSocket
confirmation arrives. They are useful for duplicate suppression and diagnostics,
but they do not appear in the normal open-order read model:

```typescript
const activeExchangeOrders = state.getOpenOrders(scope);
const activePlusPendingLocalOrders = state.getOpenOrders(scope, {
  trust: 'includeProvisional',
});
const diagnosticRows = state.getOpenOrders(scope, { trust: 'all' });
```

`trust: 'all'` includes stale rows as well as provisional rows. Most trading
logic should use the default trusted view and keep pending-confirmation state in
application workflow code.

## Position Manager Workflows

For TP/SL/DCA managers and similar live trading workflows, use
`ExchangeAccountStateStore` as the current account view rather than building a
second position or order cache.

The recommended flow is:

```text
REST snapshots and private WebSocket events
  -> ExchangeAccountStateStore
  -> getAccount(scope)
  -> application queue by affected symbol/side
  -> one workflow phase
  -> record observed submission outcomes
  -> wait for REST or WebSocket confirmation
```

Keep the workflow outside the store. Your application owns symbol-side queues,
debounce timing, phase selection, order submission, retry policy, and operator
logs. The store owns the normalized account state and readiness checks.

Before any live mutation that depends on a position or active order, re-read the
account view and confirm the premise is still true. Use REST for startup,
reconnect/gap recovery, explicit `stateChecks`, unknown submission status, and
confirmation timeouts; do not poll REST after every healthy private WebSocket
event.

See [Position manager workflow](../workflows/position-manager.md) for the
full exchange-agnostic pattern.

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

An accepted submission creates a provisional local row. That row is available
with `trust: 'includeProvisional'` and through the advanced `getAccountView()`,
but it is hidden from `getAccount(scope).openOrders` and `getOpenOrders(scope)`
until REST or private WebSocket confirmation arrives. This prevents accepted
submit responses from moving the workflow forward before the exchange has
confirmed the order.

Use `recordOrderRejected()` when the rejection should remove a provisional row
or mark open-order state uncertain. Deterministic no-order-created blocks, such
as insufficient margin or position-limit errors, usually belong in application
blocked/cooldown state instead.

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
- `stateChecks`

`positions` and `openOrders` are usually the subjects that trigger trading
logic. `stateChecks` covers readiness, confidence, watermark, and state-check
changes.

## Advanced APIs

Most application code should not need these:

- `ingest()`
- `getAccountView()`
- `getStateChecks()`
- `createAccountScopeKey()`
- `accountstate/core`

They exist for exchange adapters, replay tools, conformance fixtures, and
debugging lower-level state transitions.

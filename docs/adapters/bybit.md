# Bybit Adapter

The Bybit adapter lives at `accountstate/bybit`.

It normalizes Bybit V5 linear REST responses and private WebSocket events into
account-state updates. It does not create REST clients, WebSocket clients,
timers, API keys, retry loops, subscriptions, or reconnect logic.

For TP/SL/DCA managers and similar live workflows, read the
[position manager workflow pattern](../position-manager-workflow.md). That page
describes the symbol-side queueing and confirmation model that should live in
your application, not in the adapter. For app-level tests around that workflow,
see [Position manager conformance pattern](../conformance-position-manager.md).

## Install

```bash
npm install accountstate bybit-api
```

`bybit-api` is an optional peer dependency. You only need it when importing the
Bybit subpath. The root `accountstate` import works without Bybit installed.

## Basic Flow

```typescript
import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';
import { bybit } from 'accountstate/bybit';

const scope: AccountScope = {
  exchange: 'bybit',
  accountId: 'primary',
  product: 'linear',
  environment: 'mainnet',
};

const state = new ExchangeAccountStateStore();

state.ingest(bybit.rest.positions(scope, positionResponse.result.list));
state.ingest(bybit.rest.activeOrders(scope, activeOrdersResponse.result.list));
state.ingest(bybit.rest.walletBalances(scope, walletResponse.result.list));

ws.on('update', (event) => {
  state.ingest(bybit.ws.privateEvent(scope, event));

  for (const route of bybit.ws.routePrivateEvent(event)) {
    queueFromRoute(route);
  }
});

const account = state.getAccount(scope);
```

Your application owns the Bybit clients and private WebSocket connection. On
reconnect, call `recordStreamReconnected()` or apply a fresh REST
snapshot directly:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'Bybit private WebSocket stream restarted',
});

for (const check of state.getAccount(scope).stateChecks) {
  await checkStateSubjectFromRest(check);
}
```

## Supported V5 Linear Inputs

REST helpers:

- `bybit.rest.positions(scope, rows)`
- `bybit.rest.activeOrders(scope, rows)`
- `bybit.rest.walletBalances(scope, rows)`
- `bybit.rest.executions(scope, rows)`

Private WebSocket helpers:

- `bybit.ws.privateEvent(scope, event)`
- `bybit.ws.routePrivateEvent(event)`
- `bybit.ws.summarizePrivateEvent(event)`
- `bybit.ws.fingerprintPrivateEvent(event)`
- `bybit.ws.isTerminalOrderStatus(status)`

`privateEvent()` handles Bybit V5 private `position`, `order`, `execution`, and
`wallet` events. REST `activeOrders()` is intended for the unfiltered active
orders response, which can include regular reduce-only orders and conditional
stop orders together.

`routePrivateEvent()` returns row-level decisions for application-owned
scheduling. It distinguishes active order rows, terminal/non-active order rows,
fill evidence, position updates, and balance updates. It does not apply state,
submit orders, schedule work, or decide whether REST recovery is needed.

`summarizePrivateEvent()` returns a pure summary for logging or event
coalescing: affected subjects, symbols, assets, order IDs, position sides, and
exchange statuses. Use it for logs and coarse metrics, not as the safest
primitive for pending-confirmation logic.

`fingerprintPrivateEvent()` returns an exact-payload fingerprint for replay
protection outside the reducer.

## Private Event Routing

Use this order when processing private WebSocket events:

```typescript
state.ingest(bybit.ws.privateEvent(scope, event));

for (const route of bybit.ws.routePrivateEvent(event)) {
  switch (route.kind) {
    case 'activeOrder':
      markOrderConfirmed(route);
      break;
    case 'terminalOrder':
      markOrderTerminal(route);
      break;
    case 'executionFill':
      markSymbolDirty(route.symbol);
      break;
    case 'position':
      markSymbolDirty(route.symbol);
      break;
    case 'balance':
      markBalanceDirty(route.asset);
      break;
  }
}
```

The route helper follows Bybit V5 private stream semantics:

- `order` rows with active statuses such as `New`, `PartiallyFilled`, or
  `Untriggered` produce active order routes.
- `order` rows with terminal/non-active statuses such as `Filled`,
  `Cancelled`, `Deactivated`, `PartiallyFilledCanceled`, `Rejected`,
  `Expired`, or `Triggered` produce terminal order routes.
- `execution` rows with `execType: "Trade"` produce fill routes.
- `position` and `wallet` topics produce position and balance routes.

Terminal order routes and execution routes are not active open-order
confirmations. They should not unlock later workflow phases as if an open order
were resting on the exchange.

## Order Identity

Bybit order identity maps to the common account-state fields:

- Bybit `orderId` -> `exchangeOrderId`
- Bybit `orderLinkId` -> `customOrderId`

Application code should usually query by those common fields:

```typescript
state.getOrder(scope, { customOrderId: 'order-1' });
state.getOrder(scope, {
  exchangeOrderId: '9bb63134-6f73-4fb2-beee-56c089952da2',
});
```

For simple managers, treat submitted `orderLinkId` values as opaque unique
lookup keys, not parseable strategy state. Keep slot context in your runtime
registry and rebuild from hydrated positions after restart or lost registry
state.

## Position Mode

The adapter maps Bybit `positionIdx` into normalized position sides:

- `0` -> one-way position side, with `side` deciding LONG or SHORT
- `1` -> hedge LONG leg
- `2` -> hedge SHORT leg

When building Bybit order requests from normalized positions or orders, use
`getBybitPositionIdx(row)` instead of guessing from side strings:

```typescript
import { getBybitPositionIdx } from 'accountstate/bybit';

const positionIdx = getBybitPositionIdx(position);
```

Bybit REST can return `list: []` for settle-coin position snapshots after all
positions are closed. Passing that empty list to
`bybit.rest.positions(scope, [])` replaces the current position snapshot and
removes stale positions for that scope.

Bybit can also return symbol-scoped zero-size rows with `side: ""` and
`size: "0"`. Pass those rows into `bybit.rest.positions(scope, rows)` as-is.
The adapter treats them as flat terminal rows and limits the update to the
returned symbol, so unrelated positions are not cleared accidentally.

Bybit private WebSocket zero-size position rows are also normalized into close
updates.

Close-all conditional market stop orders may echo `qty: "0"`, `leavesQty: "0"`,
`price: "0"`, `closeOnTrigger: true`, and `reduceOnly: true`. Pass those rows
into the adapter as-is. They are valid Bybit close-all stop rows, not missing
order data.

## Filtered REST Calls

The simplest path is to pass the unfiltered linear account-state responses into
the adapter. Symbol-scoped zero-size position rows are handled automatically. If
your application deliberately calls another filtered Bybit endpoint, pass
matching `coverage` so the store only replaces the part of state that the
response actually covers.

For example, if you request only conditional active orders:

```typescript
state.ingest(
  bybit.rest.activeOrders(scope, rows, {
    coverage: { orderKinds: ['conditional'] },
  }),
);
```

## Submission Outcomes

The adapter includes pure helpers for Bybit submission outcomes. They do not
submit or cancel anything; they only convert a response or error your app
already received into account-state facts.

Accepted place helpers create provisional local rows. Those rows are available
with `state.getOpenOrders(scope, { trust: 'includeProvisional' })`, but normal
open-order reads return trusted exchange-confirmed rows only. Use provisional
rows for duplicate suppression or diagnostics, not as proof that Bybit has
confirmed the order on the private stream.

```typescript
import { bybit } from 'accountstate/bybit';

state.ingest(
  bybit.submission.placeAccepted({
    scope,
    intentId: intent.id,
    customOrderId: intent.customOrderId,
    order: provisionalOrder,
  }),
);

state.ingest(
  bybit.submission.cancelRejected({
    scope,
    identity: { customOrderId: targetCustomOrderId },
    error,
  }),
);
```

For a Bybit unknown-order cancel error, `cancelRejected()` produces absent-order
evidence. For other cancel failures it leaves the order in place and requests an
open-order refresh. Lower-level helpers such as `classifyBybitSubmissionError()`
and `isBybitUnknownOrderError()` remain available for custom handling.

The subpath also exports narrow semantic checks for common Bybit outcomes:

- `isBybitAmendNoopError()` for the idempotent amend response
  `retCode: 10001` with `retMsg` like `order not modified`
- `isBybitDuplicateOrderIdError()` for reused `orderLinkId` responses such as
  `retCode: 110072`
- `isBybitOrderQuantityWouldBeZeroError()` for reduce-only quantity failures
  such as `retCode: 110017`
- `isBybitBusinessSuccess()` for REST business responses with `retCode: 0`

`isBybitAmendNoopError()` intentionally checks both code and message.
`retCode: 10001` with `order not modified` is an amend no-op; the same code
with a message such as `Qty invalid` is not.

Deterministic no-order-created rejections usually belong in application
blocked/cooldown state. Do not automatically call `recordOrderRejected()` for
those paths unless you want accountstate to mark open-order state uncertain.

## Fixtures

The Bybit subpath exports sample-backed fixtures:

```typescript
import { bybitAccountStateFixtures } from 'accountstate/bybit';
import { runAccountStateFixtures } from 'accountstate/conformance';

const results = runAccountStateFixtures({
  fixtures: bybitAccountStateFixtures,
});
```

These fixtures cover representative V5 linear REST and private WebSocket
behavior, including one-way and hedge positions, active regular and conditional
orders, wallet balances, executions, terminal order events, zero-size position
updates, and real Bybit error payloads.

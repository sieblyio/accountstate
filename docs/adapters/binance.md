# Binance Adapter

The Binance adapter lives at `accountstate/binance`.

It normalizes Binance SDK/API payloads into account-state updates. It does not
create REST clients, WebSocket clients, listen keys, timers, API keys, retry
loops, or reconnect logic.

For a complete Binance USD-M account-state workflow using startup REST snapshots,
private account-data WebSocket updates, local submission outcomes, and reconnect
REST refresh, see
[Binance USD-M integration playbook](../integration-playbook-binance-usdm.md).

## Install

```bash
npm install accountstate binance
```

`binance` is an optional peer dependency. You only need it when importing the
Binance subpath. The root `accountstate` import works without Binance installed.

## Basic Flow

```typescript
import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';
import { binance } from 'accountstate/binance';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'mainnet',
};

const state = new ExchangeAccountStateStore();

state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
state.ingest(binance.rest.openOrders(scope, await usdm.getAllOpenOrders()));
state.ingest(
  binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
);

ws.on('formattedMessage', (event) => {
  state.ingest(binance.ws.userDataEvent(scope, event));
});
```

Your application still owns the Binance clients and account-data WebSocket
stream lifecycle. On reconnect, call `recordStreamReconnected()` or apply a
fresh REST snapshot directly:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'Binance account-data WebSocket stream restarted',
});

for (const check of state.getAccount(scope).stateChecks) {
  await checkStateSubjectFromRest(check);
}
```

## Supported USD-M Inputs

REST helpers:

- `binance.rest.positions(scope, rows)`
- `binance.rest.openOrders(scope, rows)`
- `binance.rest.openAlgoOrders(scope, rows)`
- `binance.rest.accountTrades(scope, rows)`

Private account-data WebSocket helpers:

- `binance.ws.userDataEvent(scope, event)`
- `binance.ws.spotExecutionReport(scope, event)`

`userDataEvent()` handles Binance USD-M:

- `ACCOUNT_UPDATE`
- `ORDER_TRADE_UPDATE`
- `ALGO_UPDATE`
- `TRADE_LITE`

REST balance responses are not normalized by a Binance helper yet. If you need a
REST balance snapshot, map the response into `NormalizedBalance[]` and call
`state.setBalances(scope, rows)`. `ACCOUNT_UPDATE` stream events already update
balances through `binance.ws.userDataEvent()`.

## Order Identity

Regular Binance order IDs map to regular account-state identity:

- Binance `orderId` -> `exchangeOrderId`
- Binance `clientOrderId` -> `customOrderId`

Binance Algo/conditional IDs map to trigger-order identity:

- Binance `algoId` -> `exchangeTriggerOrderId`
- Binance `clientAlgoId` -> `customTriggerOrderId`

Normal users should usually query by the regular fields they already know:

```typescript
state.getOrder(scope, { customOrderId: 'order-1' });
state.getOrder(scope, { exchangeOrderId: '1001' });
```

Trigger-order identity exists so a generated regular order and its triggering
Algo order do not collide when Binance reuses custom IDs across both objects.

## Algo Trigger Lifecycle

When a Binance USD-M Algo order triggers, Binance can emit:

- `ALGO_UPDATE` for the Algo order
- normal `ORDER_TRADE_UPDATE` events for the generated regular order

The adapter keeps those rows separate. A triggered Algo update removes only the
Algo row. The generated regular order remains governed by its regular order
updates and fills.

## Close-Position Orders

Binance can canonicalize close-position Algo orders. For example, a submitted
close-position order with a quantity may be accepted and echoed back with
quantity `0`, `closePosition: true`, and `reduceOnly: true`.

Use the exported comparison helper when comparing desired managed orders against
active Binance rows. It applies Binance USD-M defaults for common REST and
WebSocket echo fields, including close-position stop canonicalization:

```typescript
import { areBinanceManagedOrdersEquivalent } from 'accountstate/binance';

const equivalent = areBinanceManagedOrdersEquivalent({
  desired,
  active,
});
```

## Submission Outcomes

The adapter includes pure helpers for Binance submission outcomes. They do not
submit or cancel anything; they only convert a response or error your app
already received into account-state facts.

```typescript
import { binance } from 'accountstate/binance';

state.ingest(
  binance.submission.placeAccepted({
    scope,
    intentId: intent.id,
    customOrderId: intent.customOrderId,
    order: provisionalOrder,
  }),
);

state.ingest(
  binance.submission.cancelRejected({
    scope,
    identity: { customTriggerOrderId: targetCustomTriggerOrderId },
    error,
  }),
);
```

For a Binance unknown-order cancel error, `cancelRejected()` produces absent-order
evidence. For other cancel failures it leaves the order in place and requests an
open-order refresh. Lower-level helpers such as `classifyBinanceSubmissionError()`
and `isBinanceUnknownOrderError()` remain available for custom handling.

## Fixtures

The Binance subpath exports sample-backed fixtures:

```typescript
import { binanceAccountStateFixtures } from 'accountstate/binance';
import { runAccountStateFixtures } from 'accountstate/conformance';

const results = runAccountStateFixtures({
  fixtures: binanceAccountStateFixtures,
});
```

These fixtures cover representative USD-M REST and WebSocket account-state
behavior, including partial fills, Algo trigger lifecycle, close-position
canonicalization, and real unknown-order error payloads.

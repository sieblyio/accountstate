# Binance Adapter

The Binance adapter lives at `accountstate/binance`.

It normalizes Binance SDK/API payloads into account-state updates. It does not
create REST clients, WebSocket clients, listen keys, timers, API keys, retry
loops, or reconnect logic.

For a complete Binance USD-M account-state workflow using startup REST snapshots,
private WebSocket account updates, local submission outcomes, and reconnect
REST refresh, see
[Binance USD-M integration playbook](../integration-playbook-binance-usdm.md).
For TP/SL/DCA managers and similar live workflows, also read the
[position manager workflow pattern](../position-manager-workflow.md). That page
describes the symbol-side queueing and confirmation model that should live in
your application, not in the adapter.

## Install

```bash
npm install accountstate binance
```

`binance` is an optional peer dependency. You only need it when importing the
Binance subpath. The root `accountstate` import works without Binance installed.

The Binance SDK's REST `beautifyResponses` option keeps the field names used by
the supported USD-M REST helpers, but it may parse decimal strings into
JavaScript numbers. The adapter accepts either shape. Leaving REST responses raw
preserves exchange decimal strings exactly.

WebSocket formatting is separate. With `beautify: true`, the Binance SDK still
emits raw events on `message` and emits formatted events on `formattedMessage`.
Pass the formatted private WebSocket events to `binance.ws.privateEvent()`.

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
state.ingest(
  binance.rest.accountBalances(
    scope,
    (await usdm.getAccountInformationV3()).assets,
  ),
);

ws.on('formattedMessage', (event) => {
  state.ingest(binance.ws.privateEvent(scope, event));
});
```

Your application still owns the Binance clients and private WebSocket
connection. On reconnect, call `recordStreamReconnected()` or apply a
fresh REST snapshot directly:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'Binance private WebSocket stream restarted',
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
- `binance.rest.accountBalances(scope, rows)`

Private WebSocket helpers:

- `binance.ws.privateEvent(scope, event)`
- `binance.ws.summarizePrivateEvent(event)`
- `binance.ws.spotExecutionReport(scope, event)`

`privateEvent()` handles Binance USD-M:

- `ACCOUNT_UPDATE`
- `ORDER_TRADE_UPDATE`
- `ALGO_UPDATE`
- `TRADE_LITE`

`summarizePrivateEvent()` returns a pure summary for logging or event
coalescing: affected subjects, symbols, assets, order IDs, trigger-order IDs,
position sides, and exchange statuses. It does not apply state, schedule work,
or decide whether REST recovery is needed.

For USD-M REST balances, pass `getAccountInformationV3().assets` to
`binance.rest.accountBalances(scope, rows)`. `ACCOUNT_UPDATE` stream events
already update balances through `binance.ws.privateEvent()`.

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

For simple managers, treat submitted custom IDs as opaque unique lookup keys
within Binance's product-specific rules, such as any required prefix or length.
Keep slot context in your runtime registry and rebuild from hydrated positions
after restart or lost registry state.

## Algo Trigger Behavior

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

The exported comparison helper applies Binance USD-M defaults for common REST
and WebSocket echo fields, including close-position stop canonicalization:

```typescript
import { areBinanceManagedOrdersEquivalent } from 'accountstate/binance';

const equivalent = areBinanceManagedOrdersEquivalent({
  desired,
  active,
});
```

Use it as an exchange-default policy, not as a complete TP/SL/DCA planner. Your
application should still decide which app-owned slot an order belongs to and
compare only the actionable fields for that slot. For example, a regular TP or
DCA slot may care about quantity and price, while a close-position SL slot may
care about trigger price and identity rather than every field Binance echoes
back.

## Submission Outcomes

The adapter includes pure helpers for Binance submission outcomes. They do not
submit or cancel anything; they only convert a response or error your app
already received into account-state facts.

Accepted place helpers create provisional local rows. Those rows are available
with `state.getOpenOrders(scope, { trust: 'includeProvisional' })`, but normal
open-order reads return trusted exchange-confirmed rows only. Use provisional
rows for duplicate suppression or diagnostics, not as proof that Binance has
confirmed the order on the account stream.

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

The subpath also exports narrow semantic checks for common Binance outcomes:

- `isBinanceNoNeedToModifyError()` for amend no-ops such as `-5027`
- `isBinanceOrderWouldImmediatelyTriggerError()` for trigger rejection `-2021`
- `isBinanceParameterNotRequiredOrAllowedError()` for invalid order-shape
  parameters such as `-1106`
- `isBinancePositionUnavailableError()` for close-position requests that need a
  matching open position, such as `-4509`
- `isBinanceRiskLimitOrLeverageError()` for max leverage or position-limit
  failures such as `-2027`

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
behavior, including partial fills, Algo trigger behavior, close-position
canonicalization, and real unknown-order error payloads.

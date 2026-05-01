# Binance USD-M Integration Playbook

This playbook shows the common Binance USD-M account-state workflow:

```text
startup REST snapshots
  + private user-data events
  + local submit/cancel outcomes
  + reconnect REST resync
  -> accountstate
  -> application reads one current account view
```

`accountstate` does not create Binance clients, listen keys, sockets, timers,
API keys, retries, or orders. Your application owns those concerns. The store
only keeps the account view coherent from the account-state data you feed it.

## Install

```bash
npm install accountstate binance
```

`binance` is an optional peer dependency. It is required only when importing
`accountstate/binance`.

## Scope

Create one scope per exchange account, product, and environment:

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
```

## Startup REST Sync

On startup, sync the current exchange state before making trading decisions:

```typescript
async function syncFromRest(reason: string) {
  state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
  state.ingest(
    binance.rest.openOrders(scope, await usdm.getAllOpenOrders()),
  );
  state.ingest(
    binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
  );

  logAccountProjection(reason);
}
```

Add fills when the strategy uses current fill history:

```typescript
state.ingest(binance.rest.accountTrades(scope, await usdm.getAccountTrades()));
```

REST balance responses are exchange-specific and do not have a Binance helper
yet. When the strategy uses REST balances, map the response into
`NormalizedBalance[]` and pass it to `state.syncBalances(scope, rows)`.

## Private Stream Updates

During live operation, use private user-data events for account-state changes:

```typescript
function onUserDataEvent(event: unknown) {
  const changes = state.ingest(binance.ws.userDataEvent(scope, event as never));

  for (const change of Array.isArray(changes) ? changes : [changes]) {
    if (change.changed) {
      schedulePlannerPass('user_data');
      break;
    }
  }
}
```

Coalesce bursts in the application. For example, order and Algo events can
usually schedule trading logic quickly, while trade or balance-only events can
be debounced.

Do not REST sync on every private WebSocket event. REST is for startup,
reconnect/gap recovery, operator-requested checks, and explicit sync requests.

## Submission Outcomes

After placing or cancelling an order, immediately record the result you know.
Do not wait for a later WebSocket confirmation before updating local account
state.

Accepted place:

```typescript
state.orderAccepted({
  scope,
  intentId: intent.id,
  clientOrderId: intent.clientOrderId,
  order: provisionalOrder,
});
```

For accepted trigger/Algo orders, put the trigger client id on the provisional
order itself:

```typescript
state.orderAccepted({
  scope,
  intentId: intent.id,
  order: {
    ...provisionalAlgoOrder,
    kind: 'algo',
    customTriggerOrderId: intent.clientAlgoId,
  },
});
```

Accepted cancel:

```typescript
state.orderCancelled({
  scope,
  identity: { customClientOrderId: targetClientOrderId },
});
```

Accepted Algo cancel:

```typescript
state.orderCancelled({
  scope,
  identity: { customTriggerOrderId: targetClientAlgoId },
});
```

Unknown-order cancel evidence:

```typescript
import { isBinanceUnknownOrderError } from 'accountstate/binance';

if (isBinanceUnknownOrderError(error)) {
  state.orderNotFound({
    scope,
    identity: { customClientOrderId: targetClientOrderId },
  });
}
```

Rejected place:

```typescript
import { classifyBinanceSubmissionError } from 'accountstate/binance';

state.orderRejected({
  scope,
  intentId: intent.id,
  clientOrderId: intent.clientOrderId,
  error: classifyBinanceSubmissionError(error),
});
```

Timed-out or indeterminate submit:

```typescript
state.orderStatusUnknown({
  scope,
  intentId: intent.id,
  clientOrderId: intent.clientOrderId,
  error: {
    message: 'Submit request timed out before exchange status was known',
    retryable: true,
  },
});
```

The key rule: an accepted cancel proves the target order should no longer appear
in open-order results.

## Reconnect And Gap Handling

When the private stream disconnects, pause live submissions in your application
if that is appropriate for your integration:

```typescript
state.streamDisconnected(scope, { reason: 'private stream disconnected' });
```

When the stream reconnects or a sequence gap is detected, tell the store and
then satisfy the resulting REST sync requests:

```typescript
state.streamReconnected(scope, { reason: 'private stream reconnected' });
await syncRequestedStateFromRest();
```

```typescript
async function syncRequestedStateFromRest() {
  const account = state.getAccount(scope);

  for (const request of account.syncRequests) {
    if (request.subject === 'positions') {
      state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
    }

    if (request.subject === 'openOrders') {
      state.ingest(
        binance.rest.openOrders(scope, await usdm.getAllOpenOrders()),
      );
      state.ingest(
        binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
      );
    }

    if (request.subject === 'fills') {
      state.ingest(
        binance.rest.accountTrades(scope, await usdm.getAccountTrades()),
      );
    }
  }
}
```

The Binance SDK may own listen-key refresh or automatic user-data reconnects.
Treat that as SDK/client lifecycle. If account updates may have been missed,
call `streamReconnected()` or `streamGap()` and resync the requested state.

## Account View

Most integrations read `getAccount(scope)` or the direct query helpers:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders'],
});

if (!account.readyToTrade) {
  await syncRequestedStateFromRest();
  return;
}

const positions = state.getPositions(scope, { symbol: 'BTCUSDT' });
const openOrders = state.getOpenOrders(scope, { symbol: 'BTCUSDT' });
const order = state.getOrder(scope, { customClientOrderId: 'client-1' });

planner.plan({ account, positions, openOrders, order });
```

Require balances or fills when trading decisions depend on them:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders', 'balances', 'fills'],
});
```

Requests for subjects outside the required set can be handled as background
refresh work.

## Binance Algo Orders

Binance USD-M Algo orders and generated regular orders are separate rows:

- `clientAlgoId` maps to `customTriggerOrderId`.
- `algoId` maps to `exchangeTriggerOrderId`.
- regular `clientOrderId` maps to `customClientOrderId`.
- regular `orderId` maps to `exchangeOrderId`.

When an Algo order triggers, Binance can emit `ALGO_UPDATE` events for the Algo
row and `ORDER_TRADE_UPDATE` events for the generated regular order. The adapter
keeps them separate so a terminal Algo update does not overwrite the generated
regular order.

## Close-Position Order Comparison

Binance can canonicalize close-position Algo orders. A request that includes a
quantity may be accepted and echoed back with quantity `0`, `closePosition:
true`, and `reduceOnly: true`.

Use the Binance comparison policy when comparing desired close-position orders
against active exchange rows:

```typescript
import { binanceDefaultComparisonPolicies } from 'accountstate/binance';

function desiredMatchesActive(desired: NormalizedOrder, active: NormalizedOrder) {
  for (const policy of binanceDefaultComparisonPolicies) {
    if (policy.applies(desired, active)) {
      return policy.equivalent(desired, active).equivalent;
    }
  }

  return false;
}
```

## Common Mistakes

- Avoid legacy `AccountStateStore` for new exchange integrations.
- Avoid REST syncs on every private WebSocket event.
- Record accepted cancel responses immediately instead of waiting for a later
  event.
- Do not make `balances` or `fills` block readiness unless trading logic uses
  them.
- Keep Binance Algo rows and generated regular rows separate.
- Avoid running one full trading pass for every fill or balance row during an
  event burst.
- Do not compare close-position Algo rows field-for-field without the Binance
  comparison policy.
- Do not put REST clients, WebSocket clients, API keys, timers, or reconnect
  loops inside adapter code.

## Minimal Live Loop

```typescript
await connectPrivateStream();
await syncFromRest('startup');
await plannerPass('startup');

ws.on('formattedMessage', (event) => {
  state.ingest(binance.ws.userDataEvent(scope, event));
  schedulePlannerPass('user_data');
});

ws.on('reconnecting', () => {
  state.streamDisconnected(scope, { reason: 'sdk reconnecting' });
});

ws.on('reconnected', async () => {
  state.streamReconnected(scope, { reason: 'sdk reconnected' });
  await syncRequestedStateFromRest();
  await plannerPass('reconnected');
});

async function plannerPass(reason: string) {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders'],
  });

  logAccountProjection(reason, account);

  if (!account.readyToTrade) {
    await syncRequestedStateFromRest();
    return;
  }

  const intents = planner.plan(account);

  for (const intent of intents) {
    await submitAndRecord(intent);
  }
}
```

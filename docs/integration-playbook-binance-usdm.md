# Binance USD-M Integration Playbook

This playbook shows the common Binance USD-M account-state workflow:

```text
startup REST snapshots
  + private account-data events
  + local submit/cancel outcomes
  + reconnect REST refresh
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

## Startup REST Snapshot

On startup, fetch and apply the current exchange state before making trading
decisions:

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
`NormalizedBalance[]` and pass it to `state.setBalances(scope, rows)`.

## Private Account-Data Updates

During live operation, use private account-data events for account-state
changes:

```typescript
function onAccountDataEvent(event: unknown) {
  const changes = state.ingest(binance.ws.userDataEvent(scope, event as never));

  for (const change of Array.isArray(changes) ? changes : [changes]) {
    if (change.changed) {
      schedulePlannerPass('account_data');
      break;
    }
  }
}
```

Coalesce bursts in the application. For example, order and Algo events can
usually schedule trading logic quickly, while trade or balance-only events can
be debounced.

Do not query REST on every private WebSocket event. REST is for startup,
reconnect/gap recovery, operator-requested checks, and explicit `stateChecks`.

## Submission Outcomes

After placing or cancelling an order, immediately record the result you know.
Do not wait for a later WebSocket confirmation before updating local account
state.

The Binance adapter has pure outcome helpers for this. They convert responses or
errors you already received into store facts; they do not submit, cancel, retry,
or call REST.

Accepted place:

```typescript
state.ingest(
  binance.submission.placeAccepted({
    scope,
    intentId: intent.id,
    customOrderId: intent.customOrderId,
    order: provisionalOrder,
  }),
);
```

For accepted trigger/Algo orders, put the trigger custom id on the provisional
order itself:

```typescript
state.ingest(
  binance.submission.placeAccepted({
    scope,
    intentId: intent.id,
    order: {
      ...provisionalAlgoOrder,
      kind: 'algo',
      customTriggerOrderId: intent.customTriggerOrderId,
    },
  }),
);
```

Accepted cancel:

```typescript
state.ingest(
  binance.submission.cancelAccepted({
    scope,
    identity: { customOrderId: targetCustomOrderId },
  }),
);
```

Accepted Algo cancel:

```typescript
state.ingest(
  binance.submission.cancelAccepted({
    scope,
    identity: { customTriggerOrderId: targetCustomTriggerOrderId },
  }),
);
```

Unknown-order cancel evidence:

```typescript
state.ingest(
  binance.submission.cancelRejected({
    scope,
    identity: { customOrderId: targetCustomOrderId },
    error,
  }),
);
```

Rejected place:

```typescript
state.ingest(
  binance.submission.placeRejected({
    scope,
    intentId: intent.id,
    customOrderId: intent.customOrderId,
    error,
  }),
);
```

Timed-out or indeterminate submit:

```typescript
state.ingest(
  binance.submission.placeStatusUnknown({
    scope,
    intentId: intent.id,
    customOrderId: intent.customOrderId,
    error,
  }),
);
```

The key rule: an accepted cancel proves the target order should no longer appear
in open-order results.

## Reconnect And Gap Handling

When the private account-data stream disconnects, pause live submissions in your
application if that is appropriate for your integration:

```typescript
state.recordStreamDisconnected(scope, {
  reason: 'account-data stream disconnected',
});
```

When the stream reconnects or a sequence gap is detected, tell the store and
then satisfy the resulting REST-backed state checks:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'account-data stream reconnected',
});
await checkStateFromRest();
```

```typescript
async function checkStateFromRest() {
  const account = state.getAccount(scope);

  for (const check of account.stateChecks) {
    if (check.subject === 'positions') {
      state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
    }

    if (check.subject === 'openOrders') {
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

The Binance SDK may own listen-key refresh or automatic account-data reconnects.
Treat that as SDK/client lifecycle. If account updates may have been missed,
call `recordStreamReconnected()` or `recordStreamGap()` and refresh the state checks.

## Account View

Most integrations read `getAccount(scope)` or the direct query helpers:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders'],
});

if (!account.readyToTrade) {
  await checkStateFromRest();
  return;
}

const positions = state.getPositions(scope, { symbol: 'BTCUSDT' });
const openOrders = state.getOpenOrders(scope, { symbol: 'BTCUSDT' });
const order = state.getOrder(scope, { customOrderId: 'order-1' });

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
- regular `clientOrderId` maps to `customOrderId`.
- regular `orderId` maps to `exchangeOrderId`.

When an Algo order triggers, Binance can emit `ALGO_UPDATE` events for the Algo
row and `ORDER_TRADE_UPDATE` events for the generated regular order. The adapter
keeps them separate so a terminal Algo update does not overwrite the generated
regular order.

## Close-Position Order Comparison

Binance can canonicalize close-position Algo orders. A request that includes a
quantity may be accepted and echoed back with quantity `0`, `closePosition:
true`, and `reduceOnly: true`.

Use the Binance comparison helper when comparing desired managed orders against
active exchange rows. It handles common USD-M echo defaults, including
close-position stop canonicalization:

```typescript
import { areBinanceManagedOrdersEquivalent } from 'accountstate/binance';

function desiredMatchesActive(desired: NormalizedOrder, active: NormalizedOrder) {
  return areBinanceManagedOrdersEquivalent({ desired, active });
}
```

## Common Mistakes

- Avoid legacy `AccountStateStore` for new exchange integrations.
- Avoid REST queries on every private WebSocket event.
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
  schedulePlannerPass('account_data');
});

ws.on('reconnecting', () => {
  state.recordStreamDisconnected(scope, { reason: 'sdk reconnecting' });
});

ws.on('reconnected', async () => {
  state.recordStreamReconnected(scope, { reason: 'sdk reconnected' });
  await checkStateFromRest();
  await plannerPass('reconnected');
});

async function plannerPass(reason: string) {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders'],
  });

  logAccountProjection(reason, account);

  if (!account.readyToTrade) {
    await checkStateFromRest();
    return;
  }

  const intents = planner.plan(account);

  for (const intent of intents) {
    await submitAndRecord(intent);
  }
}
```

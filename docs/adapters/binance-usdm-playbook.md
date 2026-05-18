# Binance USD-M Integration Playbook

This playbook shows the common Binance USD-M account-state workflow:

```text
startup REST snapshots
  + private WebSocket account events
  + local submit/cancel outcomes
  + reconnect REST refresh
  -> accountstate
  -> application reads one current account view
```

`accountstate` does not create Binance clients, listen keys, sockets, timers,
API keys, retries, or orders. Your application owns those concerns. The store
keeps the account view current from the account-state data you feed it.

For TP/SL/DCA managers and similar live workflows, use this playbook together
with the exchange-agnostic
[position manager workflow](../workflows/position-manager.md). The
workflow document covers symbol-side queues, phase gating, confirmation, and
REST trust boundaries. Those decisions belong in your application, not in the
Binance adapter.

## Install

```bash
npm install accountstate binance
```

`binance` is an optional peer dependency. It is required only when importing
`accountstate/binance`.

With the Binance SDK, REST response beautification is optional for the supported
USD-M adapter helpers. The SDK keeps those REST field names intact, but may
parse decimal strings into JavaScript numbers. Leaving REST responses raw
preserves exchange decimal strings exactly.

WebSocket formatting is separate. With `beautify: true`, raw events are still
emitted on `message`; formatted events are emitted on `formattedMessage`. Pass
the formatted private WebSocket events to `binance.ws.privateEvent()`.

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
async function refreshFromRest(reason: string) {
  state.ingest(binance.rest.positions(scope, await usdm.getPositionsV3()));
  state.ingest(
    binance.rest.openOrders(scope, await usdm.getAllOpenOrders()),
  );
  state.ingest(
    binance.rest.openAlgoOrders(scope, await usdm.getOpenAlgoOrders()),
  );
  state.ingest(
    binance.rest.accountBalances(
      scope,
      (await usdm.getAccountInformationV3()).assets,
    ),
  );

  logAccountProjection(reason);
}
```

Add fills when the strategy uses current fill history:

```typescript
state.ingest(binance.rest.accountTrades(scope, await usdm.getAccountTrades()));
```

For USD-M REST balances, pass `getAccountInformationV3().assets` to
`binance.rest.accountBalances(scope, rows)`.

## Private WebSocket Updates

During live operation, use private WebSocket account events for account-state
changes:

```typescript
function onPrivateWebSocketEvent(event: unknown) {
  state.ingest(binance.ws.privateEvent(scope, event as never));
  const routes = binance.ws.routePrivateEvent(event as never);

  for (const route of routes) {
    queueRouteWork(route);
  }

  if (routes.length > 0) {
    scheduleWorkDrain('private_ws');
  }
}
```

Coalesce bursts in the application. For example, order and Algo events can
usually schedule trading logic quickly, while trade or balance-only events can
be debounced.

Use `binance.ws.summarizePrivateEvent(event)` for logs and coarse metrics. The
summary is only data: affected subjects, symbols, assets, order IDs,
trigger-order IDs, and exchange statuses. Use `routePrivateEvent()` when a
workflow decision depends on the row meaning or position side.

For position managers, prefer a symbol-side work queue over a product-wide
planner pass. Coalesce event bursts, read the current account view for the
queued symbol/side, run one workflow phase, and wait for confirmation before
running the next dependent phase.

Do not query REST on every private WebSocket account event. REST is for
startup, reconnect/gap recovery, operator-requested checks, and explicit
`stateChecks`.

## Submission Outcomes

After placing or cancelling an order, immediately record the result you know.
Do not wait for a later REST or WebSocket confirmation before updating local
account state.

The Binance adapter has pure outcome helpers for this. They convert responses or
errors you already received into store facts; they do not submit, cancel, retry,
or call REST.

Accepted submissions create provisional local rows. Those rows are available
with `state.getOpenOrders(scope, { trust: 'includeProvisional' })`, but the
default `getAccount(scope).openOrders` and `getOpenOrders(scope)` views expose
trusted exchange-confirmed rows only. Use provisional rows to suppress duplicate
submissions or diagnose pending work; do not use them to start DCA, cleanup, or
replacement phases before private WebSocket or REST confirmation.

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

The key rule: an accepted cancel means the target order should no longer appear
in open-order results.

## Reconnect And Gap Handling

When the private WebSocket stream disconnects, pause live
submissions in your application if that is appropriate for your integration:

```typescript
state.recordStreamDisconnected(scope, {
  reason: 'private WebSocket stream disconnected',
});
```

When the private WebSocket stream reconnects or a sequence gap is detected,
tell the store and then satisfy the resulting REST-backed state checks:

```typescript
state.recordStreamReconnected(scope, {
  reason: 'private WebSocket stream reconnected',
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

    if (check.subject === 'fills') {
      state.ingest(
        binance.rest.accountTrades(scope, await usdm.getAccountTrades()),
      );
    }

    if (check.subject === 'balances') {
      state.ingest(
        binance.rest.accountBalances(
          scope,
          (await usdm.getAccountInformationV3()).assets,
        ),
      );
    }
  }
}
```

The Binance SDK may own listen-key refresh or automatic private WebSocket
reconnects. Treat that as SDK/client connection state. If account updates may
have been missed, call `recordStreamReconnected()` or `recordStreamGap()` and
refresh the checked state through REST.

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

The Binance comparison helper handles common USD-M echo defaults, including
close-position stop canonicalization:

```typescript
import { areBinanceManagedOrdersEquivalent } from 'accountstate/binance';

function desiredMatchesActive(desired: NormalizedOrder, active: NormalizedOrder) {
  return areBinanceManagedOrdersEquivalent({ desired, active });
}
```

Use that helper as an exchange-default policy, not as the whole planner
decision. Your application should first match the app-owned slot, then compare
the fields that matter for that role. For example, a regular TP or DCA slot may
be converged when quantity and price match, while a close-position SL slot may
be converged when identity and trigger price match.

## Common Mistakes

- Avoid legacy `AccountStateStore` for new exchange integrations.
- Avoid REST queries on every private WebSocket account event.
- Record accepted cancel responses immediately instead of waiting for a later
  event.
- Do not treat accepted place responses as trusted active orders. They are
  provisional until REST or private WebSocket confirmation arrives.
- Do not make `balances` or `fills` block readiness unless trading logic uses
  them.
- Keep Binance Algo rows and generated regular rows separate.
- Avoid running one full trading pass for every fill or balance row during an
  event burst.
- Do not compare close-position Algo rows field-for-field without the Binance
  comparison policy.
- Do not use an exchange-default comparison helper as the whole TP/SL/DCA
  planner decision. Match the app-owned slot first, then compare that slot's
  actionable fields.
- Do not put REST clients, WebSocket clients, API keys, timers, or reconnect
  loops inside adapter code.

## Minimal Live Loop

```typescript
await connectPrivateWebSocket();
await refreshFromRest('startup');
queueAllOpenSymbolSides('startup');
await drainWorkQueue('startup');

ws.on('formattedMessage', (event) => {
  state.ingest(binance.ws.privateEvent(scope, event));
  for (const route of binance.ws.routePrivateEvent(event)) {
    queueRouteWork(route);
  }
  scheduleWorkDrain('private_ws');
});

ws.on('reconnecting', () => {
  state.recordStreamDisconnected(scope, { reason: 'sdk reconnecting' });
});

ws.on('reconnected', async () => {
  state.recordStreamReconnected(scope, { reason: 'sdk reconnected' });
  await checkStateFromRest();
  queueAllOpenSymbolSides('reconnected');
  await drainWorkQueue('reconnected');
});

async function drainWorkQueue(reason: string) {
  for (const work of takeQueuedSymbolSides()) {
    await runOneSymbolSidePhase(work, reason);
  }
}

async function runOneSymbolSidePhase(work: WorkKey, reason: string) {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders'],
  });

  logAccountProjection(reason, account);

  if (!account.readyToTrade) {
    await checkStateFromRest();
    return;
  }

  const phase = planner.choosePhase(account, work);
  const intents = planner.planPhase(account, work, phase);

  for (const intent of intents) {
    const latest = state.getAccount(scope, {
      requiredSubjects: ['positions', 'openOrders'],
    });
    if (!planner.premiseStillValid(latest, work, intent)) {
      continue;
    }
    await submitAndRecord(intent);
  }
}
```

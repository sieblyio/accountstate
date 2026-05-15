# Pending Confirmation Lifecycle

`accountstate` records account facts. It does not own pending-confirmation
queues, order submission, retries, or workflow phases. Applications that submit
orders should still follow a simple confirmation lifecycle around the store.

For application fixtures that test this lifecycle, see
[Position manager conformance](../testing/position-manager-conformance.md).

## Normal Place Flow

1. Create an opaque unique custom order ID.
2. Pre-register that ID in your application context, such as
   `customOrderId -> SlotKey`.
3. Submit the order through your exchange SDK.
4. Record accepted submission responses with `recordOrderAccepted()` or the
   adapter's `submission.placeAccepted()` helper.
5. Keep the order pending until REST or private WebSocket state confirms the
   active order, terminal order, or fill.

Default open-order reads return trusted exchange-confirmed rows only:

```typescript
const activeOrders = state.getOpenOrders(scope);
```

Use provisional rows only when you explicitly need them for duplicate
suppression or diagnostics:

```typescript
const pendingOrActive = state.getOpenOrders(scope, {
  trust: 'includeProvisional',
});
```

## Private Confirmation Can Arrive First

Some exchanges can emit a private WebSocket confirmation before the REST submit
promise resolves. Handle that ordering in application state.

```typescript
function onPrivateRoute(route: Route): void {
  if (route.kind !== 'activeOrder' && route.kind !== 'terminalOrder') {
    return;
  }

  const context = orderContextByCustomId.get(
    route.customOrderId ?? route.customTriggerOrderId,
  );

  if (!context) {
    return;
  }

  const pending = pendingBySlot.get(context.slotKey);

  if (pending) {
    pendingBySlot.delete(context.slotKey);
    return;
  }

  observedBeforePending.set(context.slotKey, route);
}
```

When REST acceptance later returns, check whether a private route was already
observed for that slot. If so, do not create a stale pending timeout.

## Terminal And Fill Routes

Terminal/non-active order routes and execution routes should not move the
workflow to later phases before an active open order is confirmed.

Useful handling:

- `activeOrder`: clear pending active-order confirmation for that slot.
- `terminalOrder`: clear pending/context for that order and re-read the store.
- `executionFill`: queue the symbol/side; do not treat it as open-order
  confirmation.
- `position`: queue the symbol/side.
- `balance`: update UI/risk views if your application depends on balances.

## Deterministic Rejections

Some exchange errors show that the requested order was not created, such as
insufficient margin, position-limit failures, or reduce-only requests that
cannot be satisfied while the position is flat.

Those outcomes usually belong in application blocked/cooldown state. Do not
automatically call `recordOrderRejected()` for deterministic no-order-created
blocks unless you want accountstate to mark open-order state uncertain.

Other outcomes may be ambiguous or race with private events. For those, record
the uncertainty and satisfy `stateChecks` through REST before live mutation.

## REST Boundaries

Use REST to validate state at clear trust boundaries:

- startup;
- reconnect or known stream gap;
- explicit `stateChecks`;
- unknown submit/cancel/amend outcome;
- confirmation timeout;
- operator-requested verification.

Do not poll REST after every healthy private WebSocket event. If the stream is
healthy and events are being ingested into accountstate, the store should be the
normal source of truth.

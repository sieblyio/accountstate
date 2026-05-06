# Pending Confirmation Lifecycle

`accountstate` records account facts. It does not own pending-confirmation
queues, order submission, retries, or workflow phases. Applications that submit
orders should still follow a simple confirmation lifecycle around the store.

For app-level fixtures that prove this lifecycle, see
[Position manager conformance pattern](./conformance-position-manager.md).

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
promise resolves. Binance USD-M Algo orders have been observed doing this:
`ALGO_UPDATE NEW` can arrive a few milliseconds before
`submitNewAlgoOrder()` returns.

Handle that ordering in application state:

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

Terminal/non-active order routes and execution routes should not unlock later
phases as if an active open order is resting on the exchange.

Useful handling:

- `activeOrder`: clear pending active-order confirmation for that slot.
- `terminalOrder`: clear pending/context for that order and re-read the store.
- `executionFill`: mark the symbol/side dirty; do not treat it as open-order
  confirmation.
- `position`: mark the symbol/side dirty.
- `balance`: update UI/risk views if your application depends on balances.

## Deterministic Rejections

Some exchange errors prove the requested order was not created. Examples:

- Binance `-2019` insufficient margin.
- Binance `-2027` max position or leverage limit.
- Binance `-4509` close-position order without a matching open position.
- Bybit `110017` reduce-only quantity cannot be fixed while flat.

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

# Position Manager Workflow Pattern

This pattern is for applications that manage exchange positions and their
related orders, such as TP/SL/DCA managers. It keeps `accountstate` as the
account-state source of truth without turning the store into a trading engine.

`accountstate` owns this part:

```text
REST snapshots + private WebSocket events + observed submission outcomes
  -> accountstate
  -> one current account view
```

Your application owns this part:

```text
current account view
  -> queue affected symbol/sides
  -> choose one safe phase
  -> submit/cancel/amend through your exchange SDK
  -> record the observed outcome
```

## Recommended Flow

Use this flow for live account-level workflows:

1. On startup, fetch current REST snapshots and pass them into `accountstate`.
2. Connect the private WebSocket stream and pass account events into
   `accountstate` as they arrive.
3. Use private WebSocket events as the normal live update path. Do not call
   REST after every healthy WebSocket event.
4. When positions, open orders, fills, balances, or state checks change, queue
   the affected symbol/side for application work.
5. Coalesce event bursts before running strategy logic.
6. For each queued symbol/side, read `state.getAccount(scope)` and derive the
   current position and active orders from that account view.
7. Run one workflow phase for that symbol/side, such as cleanup, protective
   orders, DCA orders, or no action.
8. Immediately before a live order mutation, re-read the account view and
   confirm the position/order premise still exists.
9. After a submit/cancel/amend attempt, record the observed outcome with the
   adapter's submission helpers or the store's `recordOrder*` methods.
10. Wait for REST or WebSocket confirmation before moving to a later phase that
    depends on the previous mutation.
11. Use REST again at trust boundaries: startup, restart, reconnect, known
    stream gap, ingest error, unknown submission status, confirmation timeout,
    operator-requested check, or `stateChecks`.

The important rule is simple: the store answers "what does the account look
like now?" The application decides "what should I do next?"

## Symbol-Side Queues

Trading workflows should usually run per symbol/side instead of product-wide on
every event. A practical queue key looks like this:

```typescript
type WorkKey = {
  exchange: string;
  accountId: string;
  product: string;
  environment?: string;
  symbol: string;
  exchangePositionSide?: 'LONG' | 'SHORT' | 'BOTH' | string;
  strategySide?: 'LONG' | 'SHORT' | string;
};
```

The queue belongs to your application, not to `accountstate`. Adapter
`ws.summarizePrivateEvent(event)` helpers can help you find affected symbols
and subjects before or after ingesting the event, but they do not schedule
work.

## Phase Gating

Avoid trying to clean up, place protective orders, place DCA orders, and repair
every mismatch in a single pass. Choose one phase from the current account
state, perform the minimum work for that phase, then wait for confirmation.

Example phase order:

1. `cleanup`: remove app-owned orders that no longer belong to an open
   position.
2. `protective`: ensure the active position has the required TP/SL protection.
3. `dca`: ensure optional add-position orders match the current strategy.
4. `noop`: no mutation is needed.

This keeps the workflow from using stale assumptions after it has just changed
the exchange state.

## Confirmation Model

A successful REST or WebSocket submission response usually means the exchange
accepted the request. It should not be treated as proof that every later account
state transition has already happened.

After an accepted place/cancel/amend:

- record the observed submission outcome in `accountstate`
- keep the affected symbol/side queued or pending
- wait for a private WebSocket update or REST check to confirm the resulting
  open-order state
- only then run the next dependent phase

If confirmation times out, mark the relevant state for checking and refresh it
through REST. Do not keep submitting based on an uncertain order state.

## REST Boundaries

REST is authoritative when you deliberately ask the exchange for current state.
Use it for:

- startup snapshots
- reconnect or stream-gap recovery
- explicit `stateChecks`
- timeout or unknown-status recovery
- operator-requested verification
- periodic background checks, if your application wants them

Private WebSocket events are the normal live update path once the stream is
healthy. Polling REST after every account event often creates race conditions:
the REST response can lag the WebSocket event that caused the planner to run.

## State Reads Before Live Mutation

Always read the account view again immediately before a live mutation that
depends on a position or active order:

```typescript
const account = state.getAccount(scope, {
  requiredSubjects: ['positions', 'openOrders'],
});

if (!account.readyToTrade) {
  await checkStateFromRest(account.stateChecks);
  return;
}

const position = account.positions.find(
  (row) =>
    row.symbol === work.symbol &&
    row.exchangePositionSide === work.exchangePositionSide,
);

if (!position || position.quantity === '0') {
  return;
}

await submitProtectiveOrder(position);
```

This is a store read, not a REST call. It catches stale queued work before your
application submits orders for a position that has already changed or closed.

## What Not To Put In Accountstate

Keep these concerns in the application, a separate strategy kit, or a companion
package:

- REST and WebSocket clients
- API keys and auth
- reconnect loops and listen-key/session management
- timers, debounce queues, and worker scheduling
- live order submission and cancellation
- TP/SL/DCA price or size generation
- slot selection, amend-first policy, and cancel/place policy
- operator logs and alert routing

Those pieces should use `accountstate`; they should not become part of the
state store.

## Common Mistakes

- Keeping a second cache of positions or open orders beside `accountstate`.
- Running a full product-wide planner pass for every order, fill, balance, or
  position event.
- Calling REST after every healthy private WebSocket event.
- Comparing every exchange echo/default field when deciding whether a managed
  order slot is already correct.
- Moving to DCA or cleanup in the same pass that just submitted protective
  orders.
- Treating an accepted submission as proof that all later account-state updates
  have already arrived.
- Submitting live mutations without re-reading the current account view.

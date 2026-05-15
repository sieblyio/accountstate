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
  -> choose one workflow phase
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
10. Treat accepted submit responses as provisional local evidence. They suppress
    duplicate submits, but they do not satisfy the default open-order read model
    and do not let dependent phases run.
11. Wait for REST or WebSocket confirmation before moving to a later phase that
    depends on the previous mutation.
12. Use REST again at trust boundaries: startup, restart, reconnect, known
    stream gap, ingest error, unknown submission status, confirmation timeout,
    operator-requested check, or `stateChecks`.

The important rule is simple: the store answers "what does the account look
like now?" The application decides "what should I do next?"

For tests that check whether an application follows this pattern, see
[Position manager conformance](../testing/position-manager-conformance.md).

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
`ws.routePrivateEvent(event)` helpers can help you route affected symbols,
orders, fills, positions, and balances after ingesting the event, but they do
not schedule work. `ws.summarizePrivateEvent(event)` remains useful for logs
and coarse metrics.

## Private Event Routing

Always feed private account events into `accountstate` immediately. Strategy
scheduling is a separate application decision.

Use `ws.routePrivateEvent(event)` where the adapter provides it, then route by
decision kind:

| Route kind | Store action | Workflow action |
| --- | --- | --- |
| `activeOrder` | ingest immediately | clear pending active-order confirmation and reconcile immediately |
| `terminalOrder` | ingest immediately | clear pending/context for that order and re-read state |
| `executionFill` | ingest immediately | queue the affected symbol/side; do not treat as open-order confirmation |
| `position` | ingest immediately | schedule a bounded trailing symbol-side reconcile |
| `balance` | ingest immediately | no workflow action unless your strategy depends on balances |
| reconnect, disconnect, or known stream gap | record stream health | satisfy `stateChecks` through REST before live mutation |

Do not debounce accountstate ingestion. If you debounce anything, debounce only
the application workflow scheduling for externally triggered position bursts.
Own-order confirmations should bypass that delay because they unblock serialized
workflows.

Some adapters require a specific private event format. Follow the adapter page
for your exchange, and feed only one event format for the same stream.

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
- read default open orders as trusted exchange-confirmed state
- use `trust: 'includeProvisional'` only for duplicate suppression or
  diagnostics
- wait for a private WebSocket update or REST check to confirm the resulting
  open-order state
- only then run the next dependent phase

If confirmation times out, mark the relevant state for checking and refresh it
through REST. Do not keep submitting based on an uncertain order state.

Private confirmation can arrive before the REST submit promise resolves. Buffer
that application-owned observation by custom order ID or slot key, then consume
it when REST acceptance returns. Do not create a stale pending timeout for an
order that the private stream already confirmed.

Adapter subpaths expose small semantic error helpers for common exchange
outcomes. Use those helpers to decide whether an observed cancel/amend failure
is an idempotent no-op, a stale-target race, or a real recovery boundary, then
record the resulting fact in the store. Those helpers do not submit orders or
update state by themselves. See the adapter pages for exchange-specific error
codes.

Deterministic no-order-created rejections should usually be handled as
application blocked/cooldown state, not as accountstate uncertainty. Use
`recordOrderRejected()` for paths where you want open-order state marked
uncertain or a provisional row removed.

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

## Custom Order IDs

For simple in-memory managers, keep exchange-visible custom order IDs opaque and
unique. They may include an app ownership prefix, and some exchanges may require
a specific prefix or length, but they should not contain strategy state.

Default split:

```text
internal SlotKey:
  deterministic product/symbol/position-side/role/step/kind

exchange-visible custom order id:
  opaque unique lookup key, plus app ownership prefix if useful

runtime registry:
  custom order id -> internal SlotKey
```

Do not encode symbol, side, role, step, lifecycle epoch, replacement generation,
or recovery state in the exchange-visible ID by default. If the runtime registry
is lost after restart or recovery, cancel app-owned open orders by prefix/scope
and rebuild from current positions.

Parseable custom IDs are an advanced option. Use them only when the application
also has durable strategy state and restart tests showing that cross-process
adoption is better than cancel-and-rebuild.

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
- Treating accepted local submission rows as trusted active exchange orders.
- Comparing every exchange echo/default field when deciding whether a managed
  order slot is already correct.
- Moving to DCA or cleanup in the same pass that just submitted protective
  orders.
- Treating an accepted submission as proof that all later account-state updates
  have already arrived.
- Submitting live mutations without re-reading the current account view.

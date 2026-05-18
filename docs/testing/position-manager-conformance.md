# Position Manager Conformance Pattern

This document describes application fixtures for position managers that use
`ExchangeAccountStateStore`. These are not reducer fixtures and they are not
part of accountstate core. They are a practical test pattern for apps that
submit orders and need to verify their workflow uses the store correctly.

Use these fixtures when building TP/SL/DCA managers, liquidation guards,
portfolio rebalancers, or any other app that reacts to private account events
and submits exchange orders.

## Boundary

`accountstate` should still own only this:

```text
REST snapshots + private WebSocket account events + observed submission facts
  -> ExchangeAccountStateStore
  -> one current account view
```

Your application owns this:

```text
route decisions + symbol/side queues + pending confirmations + submission
outcomes + strategy decisions
```

The fixtures below test that application-owned layer without moving it into
accountstate.

## Fixture Shape

Use any test runner. The important thing is the scenario boundary:

```typescript
type WorkflowFixture = {
  name: string;
  given?: WorkflowGiven;
  steps: WorkflowStep[];
  expect: WorkflowExpectation;
};

type WorkflowGiven = {
  accountState?: unknown[];
  orderContexts?: OrderContext[];
  pendingConfirmations?: PendingConfirmation[];
};

type OrderContext = {
  customOrderId: string;
  slotKey: string;
};

type PendingConfirmation = {
  customOrderId: string;
  slotKey: string;
  action: 'place' | 'amend' | 'cancel';
  expiresAtMs: number;
};

type WorkflowStep =
  | { kind: 'restSnapshot'; subject: string; payload: unknown }
  | { kind: 'privateEvent'; payload: unknown }
  | { kind: 'submissionAccepted'; action: 'place' | 'amend' | 'cancel'; payload: unknown }
  | { kind: 'submissionRejected'; action: 'place' | 'amend' | 'cancel'; error: unknown }
  | { kind: 'streamReconnected' }
  | { kind: 'tick'; nowMs: number };

type WorkflowExpectation = {
  activeOrderConfirmations?: string[];
  terminalOrderObservations?: string[];
  fillObservations?: string[];
  queuedScopes?: string[];
  pendingSlots?: string[];
  clearedPendingSlots?: string[];
  blockedSlots?: string[];
  restChecksRequested?: string[];
  submittedActions?: string[];
  forbiddenActions?: string[];
};
```

These are local app-test types, not package exports. Keep them small and adjust
names to your app. The fixtures should cover behavior, not mirror every
internal class name.

## Harness Contract

Each private event step should follow this order:

```typescript
state.ingest(exchange.ws.privateEvent(scope, event));

for (const route of exchange.ws.routePrivateEvent(event)) {
  workflow.applyRoute(route);
}
```

Each REST snapshot step should pass the raw response through the relevant
adapter helper:

```typescript
state.ingest(exchange.rest.openOrders(scope, rows));
```

Each submission outcome step should either:

- record a fact in accountstate, when it changes or may have changed account
  state; or
- update application blocked/cooldown state, when the exchange deterministically
  rejected before creating an order.

Do not call REST inside the harness after every healthy private event. REST
should appear only as an explicit fixture step or as a response to `stateChecks`.

## Core Fixtures

### Private Confirmation Before REST Acceptance

Purpose: check that a private WebSocket confirmation can arrive before the REST
submit promise resolves.

Scenario:

1. App pre-registers a custom order ID and slot.
2. Private event route arrives first.
3. REST submit acceptance arrives after.

Expected:

- private route is buffered or applied to the pending slot;
- REST acceptance does not create a stale pending timeout;
- no duplicate place is submitted;
- active exchange-confirmed state comes from REST or WebSocket account state,
  not from assuming the REST promise always resolves first.

### Terminal Order Is Not Active Confirmation

Purpose: check that terminal/non-active order rows do not clear active-open-order
confirmation for a resting order.

Scenario:

1. A pending place/amend/cancel exists for a slot.
2. Private order route arrives with a terminal/non-active status.

Expected:

- terminal observation is recorded;
- pending/context for that order is cleared or queued for the next local
  workflow step;
- the workflow re-reads accountstate before deciding what to do next;
- no dependent phase treats the route as active order confirmation.

Use the adapter route helper to classify exchange statuses. The adapter docs
list the exchange-specific mappings.

### Execution Fill Is Not Active Confirmation

Purpose: check that fills are not treated as active order visibility.

Scenario:

1. Private execution/fill route arrives with trade evidence.

Expected:

- fill is observed;
- affected symbol/side is queued for work;
- pending active-order confirmation is not cleared by fill evidence alone;
- no next DCA/protective phase runs solely because a fill route included an
  order ID.

### Deterministic No-Order-Created Rejection

Purpose: check that capacity or request-format blocks do not force accountstate
into an uncertain state when the app knows no order was created.

Scenario:

1. The exchange rejects before creating an order, and the adapter or app can
   classify that outcome.

Expected:

- app marks the slot/scope blocked or cooled down;
- no duplicate retry loop starts;
- no `recordOrderRejected()` call is made unless the app intentionally wants
  open-order state marked uncertain or a provisional row removed;
- `readyToTrade` is not forced false only because a deterministic application
  capacity block happened.

### Unknown Or Ambiguous Submission Outcome

Purpose: check that genuinely uncertain outcomes trigger REST validation before
live mutation.

Scenario:

1. Submit/cancel/amend fails with a timeout, transport issue, unclassified
   exchange error, or ambiguous SDK result.

Expected:

- app records unknown/rejected state where appropriate;
- accountstate exposes `stateChecks`;
- no further live mutation for the affected scope runs until the relevant REST
  snapshot has been ingested.

### Reconnect Requires REST Validation

Purpose: check that the app does not keep mutating from a potentially stale
stream.

Scenario:

1. Private stream reconnects or a known stream gap is observed.

Expected:

- app records stream health with `recordStreamReconnected()` or
  `recordStreamGap()`;
- accountstate exposes `stateChecks`;
- app refreshes relevant REST snapshots;
- live mutations wait until `readyToTrade` is true for required subjects.

### Trusted WebSocket State Is Not Downgraded By REST Acceptance

Purpose: check that REST submit acceptance/provisional state does not replace a
trusted private WebSocket row that already arrived.

Scenario:

1. Private active order route arrives and accountstate has trusted open-order
   state.
2. REST acceptance for the same submitted order arrives after.

Expected:

- trusted WebSocket row remains the default open-order view;
- provisional local row does not replace or downgrade trusted exchange state;
- pending confirmation is cleared.

### Startup Prunes Lost Contexts

Purpose: check that app-owned context survives only when supported by current
exchange state.

Scenario:

1. App starts with durable or in-memory order context.
2. Startup REST open-order snapshot does not contain the referenced order.

Expected:

- missing context is pruned or marked terminal;
- app does not submit cancels for absent orders in a loop;
- app rebuilds from current positions and open orders.

## Fixture Naming

Suggested fixture names:

- `private_confirmation_before_rest_acceptance`
- `terminal_order_is_not_active_confirmation`
- `execution_fill_is_not_active_confirmation`
- `deterministic_rejection_blocks_without_state_uncertainty`
- `unknown_submission_requires_state_check`
- `reconnect_requires_rest_validation`
- `trusted_ws_state_not_downgraded_by_rest_acceptance`
- `startup_prunes_contexts_absent_from_open_orders`

## Adapter-Specific Fixtures

Add exchange-specific fixtures beside the core set when an adapter has behavior
that is easy to mishandle. Examples:

- Binance private stream events can confirm an Algo order before the REST submit
  promise resolves.
- Binance and Bybit terminal statuses should be classified through their route
  helpers, not copied into application conditionals.
- Bybit close-all conditional market stops can be valid active rows even when
  `qty`, `leavesQty`, and `price` are all `"0"`.
- Deterministic no-order-created errors, such as insufficient margin or
  reduce-only quantity failures while flat, should block the app workflow
  without making accountstate readiness uncertain.

Example adapter-specific fixture names:

- `binance_algo_confirmation_before_rest_acceptance`
- `bybit_close_all_conditional_stop_qty_zero_is_active`

## What To Assert

Assert outcomes visible at the workflow boundary:

- queued scope keys;
- pending slot keys;
- cleared pending keys;
- blocked slot keys;
- whether REST checks were requested;
- whether a live action was submitted or explicitly not submitted;
- current accountstate reads such as positions/open orders/readiness.

Avoid asserting private implementation details such as internal array order,
timer handles, exact debounce delays, or complete raw exchange payload equality.
Those make tests noisy without improving coverage of the workflow boundary.

## What Not To Build Into Accountstate

Do not move these fixture concerns into `ExchangeAccountStateStore`:

- pending confirmation stores;
- work queues;
- timers and debounce;
- order submission;
- API clients;
- strategy phase selection;
- TP/SL/DCA formulas.

Those pieces can be shared later in a separate optional workflow kit if several
projects use the same workflow model. Until then, keep accountstate as the state
cache and adapter helper layer.

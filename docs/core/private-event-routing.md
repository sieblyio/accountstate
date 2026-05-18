# Private Event Routing

Private WebSocket account events should be processed in two separate steps:

```typescript
state.ingest(exchange.ws.privateEvent(scope, event));

for (const route of exchange.ws.routePrivateEvent(event)) {
  applyRouteToYourWorkflow(route);
}
```

The first line updates the account-state cache. The route loop is for your
application: queue affected work, clear pending confirmations, record that a
fill happened, or write logs. Route helpers do not mutate the store and do not
submit, cancel, retry, reconnect, or call REST.

If all you need is position entity changes, consume `change.entityChanges` from
the store write. Route helpers answer a different question: what each private
WebSocket event row means for application workflow routing.

If your app uses names like `markSymbolDirty` or `markBalanceDirty`, treat them
as application scheduling flags: "run my local workflow for this market,
position, or balance using the current store view". They do not mean "refresh
from REST". In hedge mode, keep the route's side fields in that work key when
the adapter provides them.

## Why Routes Exist

`summarizePrivateEvent()` is useful for logging and coarse metrics, but it
groups IDs and statuses into arrays. That is not precise enough for workflow
decisions. A single private event can contain rows that mean different things:

- an active order is now visible;
- an order is terminal/non-active;
- an execution fill happened;
- a position changed;
- a balance changed.

`routePrivateEvent()` keeps those meanings separate.

For application fixtures that test routing decisions, see
[Position manager conformance](../testing/position-manager-conformance.md).

## Route Kinds

Common route kinds:

- `activeOrder`: an order row that can be treated as active/resting exchange
  state.
- `terminalOrder`: an order row that should not be treated as active open-order
  confirmation.
- `executionFill`: fill evidence.
- `position`: position state changed.
- `balance`: balance state changed.

Important rules:

- Terminal/non-active order routes are not active order confirmations.
- Execution/fill routes are not active order confirmations.
- Position and fill routes should usually queue symbol/side work when the route
  includes side fields.
- Ingest private events immediately; debounce only application workflow
  scheduling if needed.
- While the private stream is healthy, trust the store instead of polling REST
  after every event.

## Adapter Mapping

Each adapter owns its exchange-specific route mapping. Read the adapter page for
the statuses and event types that map to each route kind:

- [Binance adapter](../adapters/binance.md#private-event-routing)
- [Bybit adapter](../adapters/bybit.md#private-event-routing)

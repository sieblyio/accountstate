# Private Event Routing

Private WebSocket account events should be processed in two separate steps:

```typescript
state.ingest(exchange.ws.privateEvent(scope, event));

for (const route of exchange.ws.routePrivateEvent(event)) {
  applyRouteToYourWorkflow(route);
}
```

The first line updates the account-state cache. The route loop is for your
application: mark affected work dirty, clear pending confirmations, record that
a fill happened, or write logs. Route helpers do not mutate the store and do not
submit, cancel, retry, reconnect, or call REST.

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

For app-level fixtures that prove routing decisions are handled correctly, see
[Position manager conformance pattern](./conformance-position-manager.md).

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
- Ingest private events immediately; debounce only application workflow
  scheduling if needed.
- While the private stream is healthy, trust the store instead of polling REST
  after every event.

## Binance

The Binance USD-M adapter expects SDK-formatted private events. With the
Binance SDK, raw one-letter events and formatted events can be emitted by
different event names for the same exchange event. Feed one shape into
accountstate, not both.

Binance route mapping:

- `ACCOUNT_UPDATE` -> `position` and `balance`
- `ORDER_TRADE_UPDATE` active status -> `activeOrder`
- `ORDER_TRADE_UPDATE` terminal status -> `terminalOrder`
- `ORDER_TRADE_UPDATE` with trade evidence -> `executionFill`
- `ALGO_UPDATE` active status -> `activeOrder`
- `ALGO_UPDATE` terminal/non-active status -> `terminalOrder`
- `TRADE_LITE` -> `executionFill`

`TRADE_LITE` should never clear pending open-order confirmation by itself.

## Bybit

Bybit route mapping:

- private `position` topic -> `position`
- private `wallet` topic -> `balance`
- private `execution` topic with `execType: "Trade"` -> `executionFill`
- private `order` topic with active status -> `activeOrder`
- private `order` topic with terminal/non-active status -> `terminalOrder`

For Bybit, `Triggered` is non-active for the stop-order row. Wait for the
resulting order, fill, position update, or REST state instead of treating it as
an active open-order confirmation.

Close-all conditional market stop orders may echo `qty: "0"`, `leavesQty:
"0"`, and `price: "0"` with `closeOnTrigger: true` and `reduceOnly: true`.
Those rows are valid active conditional stop rows.

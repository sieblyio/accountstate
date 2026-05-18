# Position Entity Events

Position entity events are returned by the same store call that updates account
state.

```typescript
const change = state.applyPositionUpdate(scope, position);

for (const event of change.entityChanges) {
  console.log(event.type, event.key, event.changedFields);
}
```

There is no event emitter to wire up. Your app feeds a REST snapshot, WebSocket
update, replay fact, or simulated update into the store, then reads the returned
`ChangeSet`.

## Events

The position events are:

- `position_opened`: a position became active.
- `position_quantity_increased`: the absolute position size increased.
- `position_quantity_decreased`: the absolute position size decreased.
- `position_updated`: tracked fields changed but quantity did not.
- `position_closed`: a position became flat or was missing from a snapshot that
  covers that position.

Each event includes:

- `key`: symbol, exchange position side, and strategy side.
- `changedFields`: the position fields that changed.
- `previous`: the previous position row when there was one.
- `current`: the current position row when there is one.
- `sequence`: a deterministic sequence number from this store instance.

Quantity events also include `quantityDelta`.

A one-way flip, such as LONG to SHORT, returns `position_closed` followed by
`position_opened`. That keeps the strategy-level meaning explicit.

## Basic Workflow

Use entity events to queue work. Keep order submission, logging, alerts, and
other side effects outside the store.

```typescript
const change = state.applyPositionUpdate(scope, position);

for (const event of change.entityChanges) {
  if (event.type === 'position_opened') {
    queueProtectiveOrders(event);
  }

  if (event.type === 'position_quantity_increased') {
    queueProtectionAmend(event);
  }
}
```

Before a live order mutation, read the account view again and confirm the
position still exists. A helper like this keeps that check close to the code
that submits or amends orders:

```typescript
import type { PositionEntityChange } from 'accountstate';

function hasPosition(event: PositionEntityChange): boolean {
  const account = state.getAccount(scope, {
    requiredSubjects: ['positions', 'openOrders'],
  });

  return account.positions.some(
    (position) =>
      position.symbol === event.key.symbol &&
      position.exchangePositionSide === event.key.exchangePositionSide &&
      position.strategySide === event.key.strategySide,
  );
}
```

## Startup Hydration

Initial REST hydration is often just "make the local store current". If you do
not want that hydrate call to return position events, pass
`emitEntityChanges: 'none'`.

```typescript
state.setPositions(scope, positionsFromRest, {
  asOfMs,
  emitEntityChanges: 'none',
});
```

After startup, feed private WebSocket updates normally and handle the returned
events.

## Backtests and Replays

Backtests can use the same flow as live code:

```typescript
for (const fact of replayFacts) {
  const change = state.ingest(fact);
  consume(change.entityChanges);
}
```

The important part is the order:

```text
apply account fact -> read entity changes -> queue app work
```

That sequence is easy to assert in tests and does not depend on callback timing.

## Example

See the
[entity events examples](../../examples/entityEvents/README.md)
for a small runnable example that logs every position event type.
For a live Binance USD-M REST and WebSocket example, see
[examples/binance-usdm-exchange-account-state.ts](../../examples/binance-usdm-exchange-account-state.ts).

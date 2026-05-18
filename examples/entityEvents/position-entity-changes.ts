import {
  ExchangeAccountStateStore,
  type AccountScope,
  type ChangeSet,
  type NormalizedPosition,
} from '../../dist/mjs/index.js';

const scope: AccountScope = {
  exchange: 'demo',
  accountId: 'paper',
  product: 'linear',
  environment: 'backtest',
};

const state = new ExchangeAccountStateStore();

function position(
  overrides: Partial<NormalizedPosition> = {},
): NormalizedPosition {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    signedQuantity: '0.100',
    averageEntry: '50000',
    markPrice: '50100',
    leverage: '10',
    updatedAtMs: Date.now(),
    source: 'test',
    ...overrides,
  };
}

function logChanges(label: string, change: ChangeSet): void {
  console.log(`\n${label}`);

  for (const event of change.entityChanges) {
    console.log({
      type: event.type,
      key: event.key,
      changedFields: event.changedFields,
      previousQuantity: event.previous?.quantity,
      currentQuantity: event.current?.quantity,
      previousEntry: event.previous?.averageEntry,
      currentEntry: event.current?.averageEntry,
      quantityDelta: 'quantityDelta' in event ? event.quantityDelta : undefined,
      sequence: event.sequence,
    });
  }
}

// Optional startup hydrate: no side-effect events for known initial state.
state.setPositions(scope, [], {
  asOfMs: 1,
  emitEntityChanges: 'none',
});

logChanges(
  'position_opened',
  state.applyPositionUpdate(scope, position({ updatedAtMs: 2, source: 'ws' })),
);

logChanges(
  'position_quantity_increased',
  state.applyPositionUpdate(
    scope,
    position({
      quantity: '0.250',
      signedQuantity: '0.250',
      averageEntry: '50200',
      updatedAtMs: 3,
      source: 'ws',
    }),
  ),
);

logChanges(
  'position_quantity_decreased',
  state.applyPositionUpdate(
    scope,
    position({
      quantity: '0.125',
      signedQuantity: '0.125',
      averageEntry: '50200',
      updatedAtMs: 4,
      source: 'ws',
    }),
  ),
);

logChanges(
  'position_updated',
  state.applyPositionUpdate(
    scope,
    position({
      quantity: '0.125',
      signedQuantity: '0.125',
      averageEntry: '50200',
      markPrice: '50650',
      leverage: '20',
      updatedAtMs: 5,
      source: 'ws',
    }),
  ),
);

logChanges(
  'position_closed',
  state.applyPositionUpdate(
    scope,
    position({
      strategySide: 'FLAT',
      quantity: '0',
      signedQuantity: '0',
      averageEntry: '50200',
      markPrice: '50650',
      leverage: '20',
      updatedAtMs: 6,
      source: 'ws',
    }),
  ),
);

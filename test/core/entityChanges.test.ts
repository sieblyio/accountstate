import { ExchangeAccountStateStore } from '../../src';
import type { AccountScope, NormalizedPosition } from '../../src';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

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
    averageEntry: '50000.00',
    leverage: '10',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

describe('ExchangeAccountStateStore entity changes', () => {
  it('returns position_opened when a position slot becomes active', () => {
    const state = new ExchangeAccountStateStore();

    const change = state.setPositions(scope, [position()], { asOfMs: 1 });

    expect(change.entityChanges).toHaveLength(1);
    expect(change.entityChanges[0]).toMatchObject({
      entity: 'position',
      type: 'position_opened',
      scope,
      key: {
        symbol: 'BTCUSDT',
        exchangePositionSide: 'BOTH',
        strategySide: 'LONG',
      },
      current: {
        symbol: 'BTCUSDT',
        quantity: '0.100',
      },
      changedFields: expect.arrayContaining([
        'exchangePositionSide',
        'strategySide',
        'quantity',
        'signedQuantity',
        'averageEntry',
        'leverage',
      ]),
      sequence: 1,
    });
  });

  it('can suppress entity changes for an explicit hydrate phase', () => {
    const state = new ExchangeAccountStateStore();

    const change = state.setPositions(scope, [position()], {
      asOfMs: 1,
      emitEntityChanges: 'none',
    });

    expect(change.entityChanges).toEqual([]);
    expect(state.getPositions(scope)).toEqual([position()]);
  });

  it('returns position_quantity_increased with all changed fields', () => {
    const state = new ExchangeAccountStateStore();
    state.setPositions(scope, [position()], {
      asOfMs: 1,
      emitEntityChanges: 'none',
    });

    const change = state.applyPositionUpdate(
      scope,
      position({
        quantity: '0.250',
        signedQuantity: '0.250',
        averageEntry: '51000.00',
        updatedAtMs: 2,
        source: 'ws',
      }),
    );

    expect(change.entityChanges).toEqual([
      expect.objectContaining({
        entity: 'position',
        type: 'position_quantity_increased',
        key: {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
        },
        previous: expect.objectContaining({
          quantity: '0.100',
          averageEntry: '50000.00',
        }),
        current: expect.objectContaining({
          quantity: '0.250',
          averageEntry: '51000.00',
        }),
        quantityDelta: '0.15',
        changedFields: ['quantity', 'signedQuantity', 'averageEntry'],
        sequence: 1,
      }),
    ]);
  });

  it('returns position_quantity_decreased when absolute size shrinks', () => {
    const state = new ExchangeAccountStateStore();
    state.setPositions(scope, [position({ quantity: '0.250' })], {
      asOfMs: 1,
      emitEntityChanges: 'none',
    });

    const change = state.applyPositionUpdate(
      scope,
      position({
        quantity: '0.100',
        signedQuantity: '0.100',
        updatedAtMs: 2,
        source: 'ws',
      }),
    );

    expect(change.entityChanges).toEqual([
      expect.objectContaining({
        type: 'position_quantity_decreased',
        previous: expect.objectContaining({ quantity: '0.250' }),
        current: expect.objectContaining({ quantity: '0.100' }),
        quantityDelta: '0.15',
        changedFields: expect.arrayContaining(['quantity']),
      }),
    ]);
  });

  it('returns position_updated when non-quantity tracked fields change', () => {
    const state = new ExchangeAccountStateStore();
    state.setPositions(scope, [position()], {
      asOfMs: 1,
      emitEntityChanges: 'none',
    });

    const change = state.applyPositionUpdate(
      scope,
      position({
        leverage: '20',
        markPrice: '50500.00',
        updatedAtMs: 2,
        source: 'ws',
      }),
    );

    expect(change.entityChanges).toEqual([
      expect.objectContaining({
        type: 'position_updated',
        changedFields: ['markPrice', 'leverage'],
        previous: expect.objectContaining({ leverage: '10' }),
        current: expect.objectContaining({
          leverage: '20',
          markPrice: '50500.00',
        }),
      }),
    ]);
  });

  it('returns position_closed for terminal position updates and replacement gaps', () => {
    const state = new ExchangeAccountStateStore();
    state.setPositions(
      scope,
      [
        position({ symbol: 'BTCUSDT' }),
        position({
          symbol: 'ETHUSDT',
          quantity: '1.000',
          signedQuantity: '1.000',
        }),
      ],
      { asOfMs: 1, emitEntityChanges: 'none' },
    );

    const terminalChange = state.applyPositionUpdate(
      scope,
      position({
        symbol: 'BTCUSDT',
        strategySide: 'FLAT',
        quantity: '0',
        signedQuantity: '0',
        updatedAtMs: 2,
        source: 'ws',
      }),
    );
    const replacementChange = state.setPositions(scope, [], {
      asOfMs: 3,
      mode: 'replace-scope',
    });

    expect(terminalChange.entityChanges).toEqual([
      expect.objectContaining({
        type: 'position_closed',
        key: {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
        },
        previous: expect.objectContaining({ quantity: '0.100' }),
        current: expect.objectContaining({
          strategySide: 'FLAT',
          quantity: '0',
        }),
        changedFields: expect.arrayContaining(['strategySide', 'quantity']),
        sequence: 1,
      }),
    ]);
    expect(replacementChange.entityChanges).toEqual([
      expect.objectContaining({
        type: 'position_closed',
        key: {
          symbol: 'ETHUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
        },
        previous: expect.objectContaining({ quantity: '1.000' }),
        current: undefined,
        changedFields: ['quantity'],
        sequence: 2,
      }),
    ]);
  });

  it('returns closed then opened when a one-way position flips side', () => {
    const state = new ExchangeAccountStateStore();
    state.setPositions(scope, [position()], {
      asOfMs: 1,
      emitEntityChanges: 'none',
    });

    const change = state.applyPositionUpdate(
      scope,
      position({
        strategySide: 'SHORT',
        quantity: '0.200',
        signedQuantity: '-0.200',
        updatedAtMs: 2,
        source: 'ws',
      }),
    );

    expect(change.entityChanges.map((event) => event.type)).toEqual([
      'position_closed',
      'position_opened',
    ]);
    expect(change.entityChanges).toEqual([
      expect.objectContaining({
        type: 'position_closed',
        key: {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
        },
        sequence: 1,
      }),
      expect.objectContaining({
        type: 'position_opened',
        key: {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'SHORT',
        },
        current: expect.objectContaining({
          strategySide: 'SHORT',
          quantity: '0.200',
        }),
        sequence: 2,
      }),
    ]);
  });
});

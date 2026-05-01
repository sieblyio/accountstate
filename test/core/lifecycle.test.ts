import { ExchangeAccountStateStore } from '../../src';
import type {
  AccountScope,
  ManagedOrderMetadata,
  NormalizedOrder,
  NormalizedPosition,
} from '../../src';

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
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

function order(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'regular',
    exchangeOrderId: '1001',
    customOrderId: 'client-1001',
    side: 'SELL',
    type: 'LIMIT',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    price: '52000.00',
    owner: 'app',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

describe('ExchangeAccountStateStore lifecycle and ownership', () => {
  it('creates a lifecycle for an open position and preserves its epoch', () => {
    const state = new ExchangeAccountStateStore();

    const created = state.setPositions(scope, [position()], { asOfMs: 1 });
    const lifecycle = state.getLifecycle(scope, { symbol: 'BTCUSDT' });

    expect(created.lifecycleChanges.map((change) => change.change)).toEqual([
      'created',
    ]);
    expect(lifecycle).toMatchObject({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
      replacementGeneration: 0,
      status: 'open',
    });

    const unchanged = state.setPositions(
      scope,
      [position({ updatedAtMs: 2 })],
      { asOfMs: 2 },
    );

    expect(unchanged.lifecycleChanges).toEqual([]);
    expect(state.getLifecycle(scope, { symbol: 'BTCUSDT' })).toMatchObject({
      lifecycleEpoch: lifecycle?.lifecycleEpoch,
      replacementGeneration: 0,
      status: 'open',
    });
  });

  it('advances replacement generation once when the same position changes', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });

    const changed = state.setPositions(
      scope,
      [
        position({
          quantity: '0.200',
          signedQuantity: '0.200',
          averageEntry: '51000.00',
          updatedAtMs: 2,
        }),
      ],
      { asOfMs: 2 },
    );

    expect(changed.lifecycleChanges).toEqual([
      {
        change: 'generation_advanced',
        lifecycle: expect.objectContaining({
          lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
          replacementGeneration: 1,
          lastQuantity: '0.200',
          lastAverageEntry: '51000.00',
        }),
      },
    ]);

    const repeated = state.setPositions(
      scope,
      [
        position({
          quantity: '0.200',
          signedQuantity: '0.200',
          averageEntry: '51000.00',
          updatedAtMs: 2,
        }),
      ],
      { asOfMs: 2 },
    );

    expect(repeated.lifecycleChanges).toEqual([]);
    expect(state.getLifecycle(scope, { symbol: 'BTCUSDT' })).toMatchObject({
      replacementGeneration: 1,
    });
  });

  it('moves a closed position to cleanup pending while app-owned orders remain', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setOpenOrders(scope, [order()], { asOfMs: 1 });

    const closed = state.setPositions(scope, [], {
      mode: 'replace-scope',
      asOfMs: 2,
    });

    expect(closed.lifecycleChanges).toEqual([
      {
        change: 'cleanup_pending',
        lifecycle: expect.objectContaining({
          lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
          status: 'cleanup_pending',
        }),
      },
    ]);
    expect(state.getLifecycle(scope, { symbol: 'BTCUSDT' })).toMatchObject({
      status: 'cleanup_pending',
    });
  });

  it('settles and clears a closed lifecycle after app-owned orders are terminal', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setOpenOrders(scope, [order()], { asOfMs: 1 });
    state.setPositions(scope, [], { mode: 'replace-scope', asOfMs: 2 });

    const terminal = state.recordOrderNotFound({
      scope,
      identity: { customOrderId: 'client-1001' },
      atMs: 3,
    });

    expect(terminal.lifecycleChanges).toEqual([
      {
        change: 'settled',
        lifecycle: expect.objectContaining({
          lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
          status: 'settled',
        }),
      },
    ]);
    expect(state.getLifecycles(scope)).toEqual([]);
  });

  it('creates a new epoch for a fresh same-symbol same-side position', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    const closed = state.setPositions(scope, [], {
      mode: 'replace-scope',
      asOfMs: 2,
    });
    const reopened = state.setPositions(
      scope,
      [position({ updatedAtMs: 10 })],
      { asOfMs: 10 },
    );

    expect(closed.lifecycleChanges).toEqual([
      {
        change: 'settled',
        lifecycle: expect.objectContaining({
          lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
          status: 'settled',
        }),
      },
    ]);
    expect(reopened.lifecycleChanges).toEqual([
      {
        change: 'created',
        lifecycle: expect.objectContaining({
          lifecycleEpoch: 'BTCUSDT:BOTH:LONG:10',
          replacementGeneration: 0,
          status: 'open',
        }),
      },
    ]);
    expect(state.getLifecycle(scope, { symbol: 'BTCUSDT' })).toMatchObject({
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:10',
    });
  });

  it('uses registered managed-order parsers without requiring adapter internals', () => {
    const state = new ExchangeAccountStateStore();
    const metadata: ManagedOrderMetadata = {
      strategyId: 'strategy-1',
      role: 'TP',
      step: 1,
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
    };

    state.registerManagedOrderParser({
      parse(candidate) {
        return candidate.customOrderId?.startsWith('managed-')
          ? metadata
          : undefined;
      },
    });

    state.setOpenOrders(
      scope,
      [
        order({
          customOrderId: 'managed-tp-1',
          owner: 'unknown',
          metadata: undefined,
        }),
      ],
      { asOfMs: 1 },
    );

    expect(
      state.getOrder(scope, { customOrderId: 'managed-tp-1' }),
    ).toMatchObject({
      owner: 'app',
      metadata,
    });
  });
});

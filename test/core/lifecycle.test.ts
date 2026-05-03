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

function getLifecycles(state: ExchangeAccountStateStore) {
  return state.getAccountView(scope).lifecycles;
}

function getOnlyLifecycle(state: ExchangeAccountStateStore) {
  const lifecycles = getLifecycles(state);
  expect(lifecycles).toHaveLength(1);
  return lifecycles[0];
}

describe('ExchangeAccountStateStore internal lifecycle diagnostics', () => {
  it('creates a lifecycle for an open position and preserves its epoch', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    const lifecycle = getOnlyLifecycle(state);

    expect(lifecycle).toMatchObject({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
      status: 'open',
    });

    state.setPositions(scope, [position({ updatedAtMs: 2 })], { asOfMs: 2 });

    expect(getOnlyLifecycle(state)).toMatchObject({
      lifecycleEpoch: lifecycle?.lifecycleEpoch,
      status: 'open',
    });
  });

  it('updates internal lifecycle diagnostics when the same position changes', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });

    state.setPositions(
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

    expect(getOnlyLifecycle(state)).toMatchObject({
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
      lastQuantity: '0.200',
      lastAverageEntry: '51000.00',
    });

    state.setPositions(
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

    expect(getOnlyLifecycle(state)).toMatchObject({
      lastQuantity: '0.200',
      lastAverageEntry: '51000.00',
    });
  });

  it('moves a closed position to cleanup pending while app-owned orders remain', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setOpenOrders(scope, [order()], { asOfMs: 1 });

    state.setPositions(scope, [], {
      mode: 'replace-scope',
      asOfMs: 2,
    });

    expect(getOnlyLifecycle(state)).toMatchObject({
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
      status: 'cleanup_pending',
    });
  });

  it('settles and clears a closed lifecycle after app-owned orders are terminal', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setOpenOrders(scope, [order()], { asOfMs: 1 });
    state.setPositions(scope, [], { mode: 'replace-scope', asOfMs: 2 });

    state.recordOrderNotFound({
      scope,
      identity: { customOrderId: 'client-1001' },
      atMs: 3,
    });

    expect(getLifecycles(state)).toEqual([]);
  });

  it('creates a new epoch for a fresh same-symbol same-side position', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setPositions(scope, [], {
      mode: 'replace-scope',
      asOfMs: 2,
    });
    state.setPositions(scope, [position({ updatedAtMs: 10 })], {
      asOfMs: 10,
    });

    expect(getOnlyLifecycle(state)).toMatchObject({
      lifecycleEpoch: 'BTCUSDT:BOTH:LONG:10',
      status: 'open',
    });
  });

  it('uses registered managed-order parsers without requiring adapter internals', () => {
    const state = new ExchangeAccountStateStore();
    const metadata: ManagedOrderMetadata = {
      strategyId: 'strategy-1',
      role: 'TP',
      step: 1,
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

import { ExchangeAccountStateStore } from '../../src';
import type { AccountScope, NormalizedOrder } from '../../src';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

function order(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'regular',
    customOrderId: 'client-1001',
    side: 'BUY',
    type: 'LIMIT',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    price: '49000.00',
    owner: 'app',
    updatedAtMs: 1_700_000_000_000,
    source: 'local',
    ...overrides,
  };
}

describe('ExchangeAccountStateStore local submission facts', () => {
  it('accepted local submissions create provisional open orders', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order({
        customOrderId: undefined,
        status: 'new',
        source: 'local',
      }),
      acceptedAtMs: 1_700_000_000_100,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsAdded: 1,
      itemsUpdated: 0,
      itemsRemoved: 0,
      confidenceChanged: true,
      warnings: [],
    });
    expect(state.getAccountView(scope).openOrders).toEqual([
      order({
        customOrderId: 'client-1001',
        status: 'provisional',
        source: 'local',
        acceptedAtMs: 1_700_000_000_100,
        updatedAtMs: 1_700_000_000_100,
      }),
    ]);
    expect(state.getAccountView(scope).confidence.openOrders).toBe(
      'local_only',
    );
  });

  it('REST snapshots confirm provisional custom-order-id orders without duplicating them', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order({ status: 'new' }),
      acceptedAtMs: 1,
    });

    const changeSet = state.setOpenOrders(
      scope,
      [
        order({
          exchangeOrderId: '1001',
          customOrderId: 'client-1001',
          status: 'new',
          source: 'rest',
          updatedAtMs: 2,
        }),
      ],
      { mode: 'upsert-only', source: 'rest', asOfMs: 2 },
    );

    expect(changeSet).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
    });
    expect(state.getAccountView(scope).openOrders).toEqual([
      order({
        exchangeOrderId: '1001',
        customOrderId: 'client-1001',
        status: 'new',
        source: 'rest',
        updatedAtMs: 2,
      }),
    ]);
  });

  it('rejected submissions remove matching provisional orders and add state checks', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.recordOrderRejected({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      rejectedAtMs: 2,
      error: {
        message: 'Duplicate custom order id',
        code: -4116,
      },
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsRemoved: 1,
      confidenceChanged: true,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'local_submission_rejected',
    ]);
    expect(state.getAccountView(scope).openOrders).toEqual([]);
    expect(state.getAccountView(scope).confidence.openOrders).toBe('stale');
    const stateChecks = state.getStateChecks(scope);
    expect(stateChecks).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'conflicting_state',
          priority: 'soon',
          detectedAtMs: 2,
        },
      ]),
    );
    expect(stateChecks).toHaveLength(4);
    expect(stateChecks).toContainEqual({
      scope,
      subject: 'positions',
      reason: 'startup',
      priority: 'immediate',
    });
    expect(stateChecks).toContainEqual({
      scope,
      subject: 'balances',
      reason: 'startup',
      priority: 'immediate',
    });
    expect(stateChecks).toContainEqual({
      scope,
      subject: 'fills',
      reason: 'startup',
      priority: 'background',
    });
    expect(state.getAccountView(scope).stateCheckReasons).toContain(
      'openOrders_conflicting_state',
    );
  });

  it('unknown submissions keep provisional orders visible and add immediate state checks', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.recordOrderStatusUnknown({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      atMs: 2,
      error: {
        message: 'Network timeout after request submission',
        retryable: true,
      },
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsRemoved: 0,
      confidenceChanged: true,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'local_submission_unknown',
    ]);
    expect(state.getAccountView(scope).openOrders).toHaveLength(1);
    expect(state.getAccountView(scope).openOrders[0].status).toBe(
      'provisional',
    );
    const stateChecks = state.getStateChecks(scope);
    expect(stateChecks).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'submission_unknown',
          priority: 'immediate',
          detectedAtMs: 2,
        },
      ]),
    );
    expect(stateChecks).toHaveLength(4);
    expect(state.getAccountView(scope).stateCheckReasons).toContain(
      'openOrders_submission_unknown',
    );
  });

  it('terminal evidence removes matching active orders by any identity', () => {
    const state = new ExchangeAccountStateStore();

    state.setOpenOrders(
      scope,
      [
        order({
          exchangeOrderId: '1001',
          customOrderId: 'client-1001',
          source: 'rest',
        }),
      ],
      { mode: 'upsert-only', source: 'rest', asOfMs: 1 },
    );

    const changeSet = state.recordOrderNotFound({
      scope,
      identity: { customOrderId: 'client-1001' },
      reason: 'order_not_found',
      atMs: 2,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsRemoved: 1,
      warnings: [],
    });
    expect(state.getAccountView(scope).openOrders).toEqual([]);
  });

  it('terminal evidence warns when no active order matches', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = state.recordOrderNotFound({
      scope,
      identity: { customOrderId: 'missing-custom-order-id' },
      reason: 'manual_operator_terminal',
      atMs: 1,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsRemoved: 0,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'terminal_order_not_found',
    ]);
  });

  it('duplicate accepted custom order ids produce a warning without duplicate rows', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.recordOrderAccepted({
      scope,
      intentId: 'intent-2',
      customOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 2,
    });

    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'duplicate_active_custom_order_id',
    ]);
    expect(state.getAccountView(scope).openOrders).toHaveLength(1);
    expect(state.getAccountView(scope).openOrders[0]).toMatchObject({
      customOrderId: 'client-1001',
      status: 'provisional',
      acceptedAtMs: 2,
    });
  });

  it('state checks are cloned before being returned', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderStatusUnknown({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      atMs: 1,
      error: {
        message: 'Unknown result',
      },
    });

    const requests = state.getStateChecks(scope);
    requests[0].scope.accountId = 'mutated';

    expect(state.getStateChecks(scope)[0].scope.accountId).toBe('primary');
  });
});

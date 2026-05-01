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
    customClientOrderId: 'client-1001',
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

    const changeSet = state.orderAccepted({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      order: order({
        customClientOrderId: undefined,
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
        customClientOrderId: 'client-1001',
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

  it('REST snapshots confirm provisional client-id orders without duplicating them', () => {
    const state = new ExchangeAccountStateStore();

    state.orderAccepted({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      order: order({ status: 'new' }),
      acceptedAtMs: 1,
    });

    const changeSet = state.syncOpenOrders(
      scope,
      [
        order({
          exchangeOrderId: '1001',
          customClientOrderId: 'client-1001',
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
        customClientOrderId: 'client-1001',
        status: 'new',
        source: 'rest',
        updatedAtMs: 2,
      }),
    ]);
  });

  it('rejected submissions remove matching provisional orders and request sync', () => {
    const state = new ExchangeAccountStateStore();

    state.orderAccepted({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.orderRejected({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      rejectedAtMs: 2,
      error: {
        message: 'Duplicate client order id',
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
    const syncRequests = state.getSyncRequests(scope);
    expect(syncRequests).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'conflicting_state',
          priority: 'soon',
          requestedAtMs: 2,
        },
      ]),
    );
    expect(syncRequests).toHaveLength(4);
    expect(syncRequests).toContainEqual({
      scope,
      subject: 'positions',
      reason: 'startup',
      priority: 'immediate',
    });
    expect(syncRequests).toContainEqual({
      scope,
      subject: 'balances',
      reason: 'startup',
      priority: 'immediate',
    });
    expect(syncRequests).toContainEqual({
      scope,
      subject: 'fills',
      reason: 'startup',
      priority: 'background',
    });
    expect(state.getAccountView(scope).syncReasons).toContain(
      'openOrders_conflicting_state',
    );
  });

  it('unknown submissions keep provisional orders visible and request immediate sync', () => {
    const state = new ExchangeAccountStateStore();

    state.orderAccepted({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.orderStatusUnknown({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
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
    const syncRequests = state.getSyncRequests(scope);
    expect(syncRequests).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'submission_unknown',
          priority: 'immediate',
          requestedAtMs: 2,
        },
      ]),
    );
    expect(syncRequests).toHaveLength(4);
    expect(state.getAccountView(scope).syncReasons).toContain(
      'openOrders_submission_unknown',
    );
  });

  it('terminal evidence removes matching active orders by any identity', () => {
    const state = new ExchangeAccountStateStore();

    state.syncOpenOrders(
      scope,
      [
        order({
          exchangeOrderId: '1001',
          customClientOrderId: 'client-1001',
          source: 'rest',
        }),
      ],
      { mode: 'upsert-only', source: 'rest', asOfMs: 1 },
    );

    const changeSet = state.orderNotFound({
      scope,
      identity: { customClientOrderId: 'client-1001' },
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

    const changeSet = state.orderNotFound({
      scope,
      identity: { customClientOrderId: 'missing-client-id' },
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

  it('duplicate accepted custom client ids produce a warning without duplicate rows', () => {
    const state = new ExchangeAccountStateStore();

    state.orderAccepted({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.orderAccepted({
      scope,
      intentId: 'intent-2',
      clientOrderId: 'client-1001',
      order: order(),
      acceptedAtMs: 2,
    });

    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'duplicate_active_custom_client_order_id',
    ]);
    expect(state.getAccountView(scope).openOrders).toHaveLength(1);
    expect(state.getAccountView(scope).openOrders[0]).toMatchObject({
      customClientOrderId: 'client-1001',
      status: 'provisional',
      acceptedAtMs: 2,
    });
  });

  it('sync requests are cloned before being returned', () => {
    const state = new ExchangeAccountStateStore();

    state.orderStatusUnknown({
      scope,
      intentId: 'intent-1',
      clientOrderId: 'client-1001',
      atMs: 1,
      error: {
        message: 'Unknown result',
      },
    });

    const requests = state.getSyncRequests(scope);
    requests[0].scope.accountId = 'mutated';

    expect(state.getSyncRequests(scope)[0].scope.accountId).toBe('primary');
  });
});

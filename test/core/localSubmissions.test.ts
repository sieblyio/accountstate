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

    const changeSet = state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      order: order({
        customClientOrderId: undefined,
        status: 'new',
        source: 'local',
      }),
      acceptedAtMs: 1_700_000_000_100,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsTerminal: 0,
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

    state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      order: order({ status: 'new' }),
      acceptedAtMs: 1,
    });

    const changeSet = state.applySnapshot({
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [
        order({
          exchangeOrderId: '1001',
          customClientOrderId: 'client-1001',
          status: 'new',
          source: 'rest',
          updatedAtMs: 2,
        }),
      ],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      rowsInserted: 0,
      rowsUpdated: 1,
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

  it('rejected submissions remove matching provisional orders and request hydration', () => {
    const state = new ExchangeAccountStateStore();

    state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.applyLocalSubmissionRejected({
      type: 'local_submission_rejected',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      rejectedAtMs: 2,
      error: {
        message: 'Duplicate client order id',
        code: -4116,
      },
    });

    expect(changeSet).toMatchObject({
      changed: true,
      rowsTerminal: 1,
      confidenceChanged: true,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'local_submission_rejected',
    ]);
    expect(state.getAccountView(scope).openOrders).toEqual([]);
    expect(state.getAccountView(scope).confidence.openOrders).toBe('stale');
    expect(state.getHydrationNeeds(scope)).toEqual([
      {
        scope,
        subject: 'openOrders',
        reason: 'conflicting_state',
        priority: 'soon',
        requestedAtMs: 2,
      },
    ]);
    expect(state.getAccountView(scope).hydrationReasons).toContain(
      'openOrders_conflicting_state',
    );
  });

  it('unknown submissions keep provisional orders visible and request immediate hydration', () => {
    const state = new ExchangeAccountStateStore();

    state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.applyLocalSubmissionUnknown({
      type: 'local_submission_unknown',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      atMs: 2,
      error: {
        message: 'Network timeout after request submission',
        retryable: true,
      },
    });

    expect(changeSet).toMatchObject({
      changed: true,
      rowsTerminal: 0,
      confidenceChanged: true,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'local_submission_unknown',
    ]);
    expect(state.getAccountView(scope).openOrders).toHaveLength(1);
    expect(state.getAccountView(scope).openOrders[0].status).toBe(
      'provisional',
    );
    expect(state.getHydrationNeeds(scope)).toEqual([
      {
        scope,
        subject: 'openOrders',
        reason: 'submission_unknown',
        priority: 'immediate',
        requestedAtMs: 2,
      },
    ]);
    expect(state.getAccountView(scope).hydrationReasons).toContain(
      'openOrders_submission_unknown',
    );
  });

  it('terminal evidence removes matching active orders by any identity', () => {
    const state = new ExchangeAccountStateStore();

    state.applySnapshot({
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [
        order({
          exchangeOrderId: '1001',
          customClientOrderId: 'client-1001',
          source: 'rest',
        }),
      ],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = state.markOrderTerminal({
      type: 'terminal_evidence',
      scope,
      identity: { customClientOrderId: 'client-1001' },
      reason: 'unknown_order_cancel_absent_from_hydration',
      atMs: 2,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      rowsTerminal: 1,
      warnings: [],
    });
    expect(state.getAccountView(scope).openOrders).toEqual([]);
  });

  it('terminal evidence warns when no active order matches', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = state.markOrderTerminal({
      type: 'terminal_evidence',
      scope,
      identity: { customClientOrderId: 'missing-client-id' },
      reason: 'manual_operator_terminal',
      atMs: 1,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      rowsTerminal: 0,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'terminal_order_not_found',
    ]);
  });

  it('duplicate accepted custom client ids produce a warning without duplicate rows', () => {
    const state = new ExchangeAccountStateStore();

    state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.applyLocalSubmissionAccepted({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-2',
      clientId: 'client-1001',
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

  it('hydration needs are cloned before being returned', () => {
    const state = new ExchangeAccountStateStore();

    state.applyLocalSubmissionUnknown({
      type: 'local_submission_unknown',
      scope,
      intentId: 'intent-1',
      clientId: 'client-1001',
      atMs: 1,
      error: {
        message: 'Unknown result',
      },
    });

    const needs = state.getHydrationNeeds(scope);
    needs[0].scope.accountId = 'mutated';

    expect(state.getHydrationNeeds(scope)[0].scope.accountId).toBe('primary');
  });
});

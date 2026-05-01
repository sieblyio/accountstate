import { ExchangeAccountStateStore } from '../../src';
import { getBuiltInInvariantViolations } from '../../src/core/invariants';
import type {
  AccountScope,
  NormalizedOrder,
  NormalizedPosition,
  PositionLifecycle,
} from '../../src';
import type { AccountView } from '../../src/core';

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
    side: 'BUY',
    type: 'LIMIT',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    price: '49000.00',
    owner: 'app',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<PositionLifecycle> = {},
): PositionLifecycle {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    lifecycleEpoch: 'BTCUSDT:BOTH:LONG:1',
    replacementGeneration: 0,
    openedAtMs: 1,
    lastQuantity: '0.100',
    lastAverageEntry: '50000.00',
    status: 'open',
    ...overrides,
  };
}

function view(overrides: Partial<AccountView> = {}): AccountView {
  return {
    scope,
    positions: [],
    openOrders: [],
    balances: [],
    fills: [],
    lifecycles: [],
    confidence: {
      positions: 'synced',
      openOrders: 'synced',
      balances: 'synced',
      fills: 'unknown',
      ...overrides.confidence,
    },
    watermarks: {},
    hasStateChecks: false,
    stateCheckReasons: [],
    ...overrides,
  };
}

function violationNames(state: ExchangeAccountStateStore): string[] {
  return state.checkInvariants(scope).map((violation) => violation.name);
}

describe('ExchangeAccountStateStore invariants', () => {
  it('detects duplicate active custom order ids', () => {
    const violations = getBuiltInInvariantViolations(
      view({
        openOrders: [
          order({ exchangeOrderId: '1001', customOrderId: 'duplicate' }),
          order({ exchangeOrderId: '1002', customOrderId: 'duplicate' }),
        ],
        positions: [position()],
        lifecycles: [lifecycle()],
      }),
    );

    expect(violations.map((violation) => violation.name)).toEqual([
      'duplicate_active_custom_order_id',
    ]);

    const ok = getBuiltInInvariantViolations(
      view({
        openOrders: [
          order({ exchangeOrderId: '1001', customOrderId: 'duplicate' }),
          order({
            exchangeOrderId: '1002',
            customOrderId: 'duplicate',
            status: 'cancelled',
          }),
        ],
        positions: [position()],
        lifecycles: [lifecycle()],
      }),
    );
    expect(ok.map((violation) => violation.name)).not.toContain(
      'duplicate_active_custom_order_id',
    );
  });

  it('detects active app-owned orders without a lifecycle', () => {
    const state = new ExchangeAccountStateStore();

    state.setOpenOrders(scope, [order()], { asOfMs: 1 });
    expect(violationNames(state)).toContain(
      'active_app_order_without_lifecycle',
    );

    state.setPositions(scope, [position()], { asOfMs: 1 });
    expect(violationNames(state)).not.toContain(
      'active_app_order_without_lifecycle',
    );
  });

  it('detects active lifecycles without matching open positions', () => {
    const violations = getBuiltInInvariantViolations(
      view({ lifecycles: [lifecycle()] }),
    );

    expect(violations.map((violation) => violation.name)).toEqual([
      'active_lifecycle_without_position',
    ]);

    const ok = getBuiltInInvariantViolations(
      view({
        lifecycles: [lifecycle({ status: 'cleanup_pending' })],
      }),
    );
    expect(ok).toEqual([]);
  });

  it('detects stale provisional orders after the configured grace period', () => {
    const state = new ExchangeAccountStateStore();

    state.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: order({ exchangeOrderId: undefined, source: 'local' }),
      acceptedAtMs: 1,
    });

    expect(
      state
        .checkInvariants(scope, {
          nowMs: 100,
          provisionalOrderStaleMs: 10,
        })
        .map((violation) => violation.name),
    ).toContain('stale_provisional_order');
    expect(
      state
        .checkInvariants(scope, {
          nowMs: 5,
          provisionalOrderStaleMs: 10,
        })
        .map((violation) => violation.name),
    ).not.toContain('stale_provisional_order');
  });

  it('detects account views marked fresh while required confidence is unsafe', () => {
    const violations = getBuiltInInvariantViolations(
      view({
        confidence: {
          positions: 'unknown',
          openOrders: 'synced',
          balances: 'synced',
          fills: 'unknown',
        },
        hasStateChecks: false,
      }),
    );

    expect(violations.map((violation) => violation.name)).toEqual([
      'unsafe_ready_account_view',
    ]);

    const ok = getBuiltInInvariantViolations(
      view({
        confidence: {
          positions: 'unknown',
          openOrders: 'synced',
          balances: 'synced',
          fills: 'unknown',
        },
        hasStateChecks: true,
      }),
    );
    expect(ok).toEqual([]);
  });

  it('detects binary-float-looking decimal strings only when enabled', () => {
    const state = new ExchangeAccountStateStore();

    state.setPositions(scope, [position({ quantity: '0.30000000000000004' })], {
      asOfMs: 1,
    });

    expect(
      state
        .checkInvariants(scope, { validateDecimalStrings: true })
        .map((violation) => violation.name),
    ).toContain('binary_float_decimal_string');
    expect(
      state
        .checkInvariants(scope, { validateDecimalStrings: false })
        .map((violation) => violation.name),
    ).not.toContain('binary_float_decimal_string');
  });

  it('runs registered custom invariants', () => {
    const state = new ExchangeAccountStateStore();

    state.registerInvariant({
      name: 'custom_check',
      severity: 'warn',
      check(candidateView) {
        return [
          {
            message: 'Custom invariant ran.',
            context: { accountId: candidateView.scope.accountId },
          },
        ];
      },
    });

    expect(state.checkInvariants(scope)).toEqual([
      {
        name: 'custom_check',
        severity: 'warn',
        scope,
        message: 'Custom invariant ran.',
        context: { accountId: 'primary' },
      },
    ]);
  });
});

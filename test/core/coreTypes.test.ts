import type {
  AccountScope,
  ChangeSet,
  StateCheck,
  ManagedOrderParser,
  NormalizedOrder,
  NormalizedPosition,
  StateInvariant,
} from '../../src/index';
import type {
  AccountFact,
  AccountView,
  OrderComparisonPolicy,
  RestSnapshotFact,
} from '../../src/core';
import {
  assertDecimalString,
  isDecimalString,
  toDecimalString,
} from '../../src/core/decimal';
import {
  copyScope,
  createAccountScopeKey,
  createScopeKey,
  isSameScope,
} from '../../src/core/utils';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

function normalizedPosition(): NormalizedPosition {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    signedQuantity: '0.100',
    averageEntry: '50000.00',
    updatedAtMs: 1_700_000_000_000,
    source: 'rest',
  };
}

function normalizedOrder(overrides: Partial<NormalizedOrder> = {}) {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'regular',
    exchangeOrderId: '12345',
    customOrderId: 'client-12345',
    side: 'BUY',
    type: 'LIMIT',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    price: '49000.00',
    owner: 'app',
    metadata: {
      strategyId: 'strategy-1',
      role: 'DCA',
      step: 1,
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
    },
    updatedAtMs: 1_700_000_000_000,
    source: 'rest',
    ...overrides,
  } satisfies NormalizedOrder;
}

describe('core type contracts', () => {
  it('allows normalized account facts to be assembled through the root type exports', () => {
    const position = normalizedPosition();
    const order = normalizedOrder();

    const snapshot: RestSnapshotFact<NormalizedPosition> = {
      type: 'rest_snapshot',
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [position],
      asOfMs: 1_700_000_000_000,
      source: 'rest',
      coverage: {
        symbols: ['BTCUSDT'],
        positionSides: ['BOTH'],
      },
    };

    const facts: AccountFact[] = [
      snapshot,
      {
        type: 'order_updated',
        scope,
        order,
        provenance: {
          source: 'ws',
          receivedAtMs: 1_700_000_000_100,
          exchangeEventTimeMs: 1_700_000_000_050,
          eventId: 'event-1',
        },
      },
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-12345',
        order: normalizedOrder({ status: 'provisional', source: 'local' }),
        acceptedAtMs: 1_700_000_000_200,
      },
      {
        type: 'terminal_evidence',
        scope,
        identity: { customOrderId: 'client-12345' },
        reason: 'cancelled',
        atMs: 1_700_000_000_300,
      },
    ];

    expect(facts.map((fact) => fact.type)).toEqual([
      'rest_snapshot',
      'order_updated',
      'local_submission_accepted',
      'terminal_evidence',
    ]);
  });

  it('allows account views, change sets, state checks, and plugin contracts to compile together', () => {
    const position = normalizedPosition();
    const order = normalizedOrder();

    const view: AccountView = {
      scope,
      positions: [position],
      openOrders: [order],
      balances: [
        {
          ...scope,
          asset: 'USDT',
          walletBalance: '1000.00',
          availableBalance: '900.00',
          updatedAtMs: 1_700_000_000_000,
          source: 'rest',
        },
      ],
      fills: [],
      lifecycles: [
        {
          ...scope,
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
          lifecycleEpoch: 'epoch-1',
          openedAtMs: 1_700_000_000_000,
          lastQuantity: '0.100',
          lastAverageEntry: '50000.00',
          status: 'open',
        },
      ],
      confidence: {
        positions: 'synced',
        openOrders: 'rest_and_stream',
        balances: 'synced',
        fills: 'unknown',
      },
      watermarks: {
        positions: {
          source: 'rest',
          asOfMs: 1_700_000_000_000,
        },
      },
      hasStateChecks: false,
      stateCheckReasons: [],
    };

    const stateCheck: StateCheck = {
      scope,
      subject: 'openOrders',
      reason: 'startup',
      priority: 'immediate',
    };

    const changeSet: ChangeSet = {
      scope,
      changed: true,
      changedSubjects: ['positions', 'stateChecks'],
      itemsAdded: 1,
      itemsUpdated: 0,
      itemsRemoved: 0,
      itemsMarkedStale: 0,
      confidenceChanged: true,
      warnings: [],
    };

    const parser: ManagedOrderParser = {
      parse(candidate) {
        return candidate.metadata;
      },
    };

    const invariant: StateInvariant = {
      name: 'no_open_order_without_symbol',
      severity: 'error',
      check(candidateView) {
        return candidateView.openOrders
          .filter((candidateOrder) => !candidateOrder.symbol)
          .map((candidateOrder) => ({
            message: 'Open order is missing a symbol.',
            context: {
              customOrderId: candidateOrder.customOrderId,
            },
          }));
      },
    };

    const comparisonPolicy: OrderComparisonPolicy = {
      name: 'exact_client_id_match',
      applies(desired, active) {
        return Boolean(
          desired.customOrderId && active.customOrderId,
        );
      },
      equivalent(desired, active) {
        return {
          equivalent:
            desired.customOrderId === active.customOrderId,
        };
      },
    };

    expect(view.positions).toEqual([position]);
    expect(stateCheck.subject).toBe('openOrders');
    expect(changeSet.changed).toBe(true);
    expect(parser.parse(order)).toEqual(order.metadata);
    expect(invariant.check(view)).toEqual([]);
    expect(comparisonPolicy.equivalent(order, order, {}).equivalent).toBe(true);
  });
});

describe('core decimal helpers', () => {
  it.each(['0', '1', '-1', '+1', '0.1', '.5', '-0.0001'])(
    'accepts plain decimal string %s',
    (value) => {
      expect(isDecimalString(value)).toBe(true);
      expect(assertDecimalString(value)).toBe(value);
    },
  );

  it.each(['', 'abc', '1e-8', 'Infinity', 'NaN'])(
    'rejects non-plain decimal string %s',
    (value) => {
      expect(isDecimalString(value)).toBe(false);
      expect(() => assertDecimalString(value)).toThrow(
        `Invalid decimal string: ${value}`,
      );
    },
  );

  it('converts strings and finite numbers into decimal strings', () => {
    expect(toDecimalString('123.45')).toBe('123.45');
    expect(toDecimalString(123.45)).toBe('123.45');
  });
});

describe('core scope helpers', () => {
  it('creates stable scope keys and compares scopes by all scope fields', () => {
    const copiedScope = copyScope(scope);

    expect(copiedScope).toEqual(scope);
    expect(copiedScope).not.toBe(scope);
    expect(createAccountScopeKey(scope)).toBe('binance:primary:usdm:testnet');
    expect(createScopeKey(scope)).toBe('binance:primary:usdm:testnet');
    expect(isSameScope(scope, copiedScope)).toBe(true);
    expect(
      isSameScope(scope, {
        ...scope,
        environment: 'mainnet',
      }),
    ).toBe(false);
  });

  it('uses an empty environment segment when environment is omitted', () => {
    expect(
      createScopeKey({
        exchange: 'bybit',
        accountId: 'primary',
        product: 'linear',
      }),
    ).toBe('bybit:primary:linear:');
  });
});

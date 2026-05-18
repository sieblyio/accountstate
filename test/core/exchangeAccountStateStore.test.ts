import { ExchangeAccountStateStore } from '../../src';
import type {
  AccountScope,
  ChangeSet,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../src';
import type { SnapshotInput } from '../../src/core';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

const otherScope: AccountScope = {
  exchange: 'bybit',
  accountId: 'primary',
  product: 'linear',
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
    updatedAtMs: 1_700_000_000_000,
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
    owner: 'unknown',
    updatedAtMs: 1_700_000_000_000,
    source: 'rest',
    ...overrides,
  };
}

function balance(
  overrides: Partial<NormalizedBalance> = {},
): NormalizedBalance {
  return {
    ...scope,
    asset: 'USDT',
    walletBalance: '1000.00',
    availableBalance: '900.00',
    updatedAtMs: 1_700_000_000_000,
    source: 'rest',
    ...overrides,
  };
}

function fill(overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    exchangeTradeId: 'trade-1001',
    exchangeOrderId: '1001',
    side: 'BUY',
    price: '49000.00',
    quantity: '0.100',
    executedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    source: 'rest',
    ...overrides,
  };
}

function syncSnapshot(
  state: ExchangeAccountStateStore,
  input: SnapshotInput<unknown>,
): ChangeSet {
  switch (input.subject) {
    case 'positions':
      return state.setPositions(
        input.scope,
        input.rows as NormalizedPosition[],
        input,
      );
    case 'openOrders':
      return state.setOpenOrders(
        input.scope,
        input.rows as NormalizedOrder[],
        input,
      );
    case 'balances':
      return state.setBalances(
        input.scope,
        input.rows as NormalizedBalance[],
        input,
      );
    case 'fills':
      return state.setFills(input.scope, input.rows as NormalizedFill[], input);
    case 'filters':
      throw new Error('Filter snapshots do not have a public setter yet.');
  }
}

describe('ExchangeAccountStateStore snapshots', () => {
  it('starts with an empty unknown account view', () => {
    const state = new ExchangeAccountStateStore();

    expect(state.getAccountView(scope)).toEqual({
      scope,
      positions: [],
      openOrders: [],
      balances: [],
      fills: [],
      lifecycles: [],
      confidence: {
        positions: 'unknown',
        openOrders: 'unknown',
        balances: 'unknown',
        fills: 'unknown',
      },
      watermarks: {},
      hasStateChecks: true,
      stateCheckReasons: [
        'positions_unknown',
        'openOrders_unknown',
        'balances_unknown',
        'fills_unknown',
      ],
    });
  });

  it('upserts position snapshots and marks position confidence synced', () => {
    const state = new ExchangeAccountStateStore();
    const btcPosition = position();

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [btcPosition],
      source: 'rest',
      asOfMs: 1_700_000_000_000,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsAdded: 1,
      itemsUpdated: 0,
      itemsRemoved: 0,
      itemsMarkedStale: 0,
      confidenceChanged: true,
    });

    const view = state.getAccountView(scope);
    expect(view.positions).toEqual([btcPosition]);
    expect(view.confidence.positions).toBe('synced');
    expect(view.watermarks.positions).toEqual({
      source: 'rest',
      asOfMs: 1_700_000_000_000,
    });
  });

  it('does not report row changes for an identical snapshot with the same watermark', () => {
    const state = new ExchangeAccountStateStore();
    const btcPosition = position();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [btcPosition],
      source: 'rest',
      asOfMs: 1,
    });

    expect(
      syncSnapshot(state, {
        scope,
        subject: 'positions',
        mode: 'replace-scope',
        rows: [btcPosition],
        source: 'rest',
        asOfMs: 1,
      }),
    ).toMatchObject({
      changed: false,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsRemoved: 0,
      itemsMarkedStale: 0,
      confidenceChanged: false,
    });
  });

  it('upsert-only snapshots do not remove absent rows', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [position({ symbol: 'BTCUSDT' })],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [position({ symbol: 'ETHUSDT' })],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      itemsAdded: 1,
      itemsUpdated: 0,
      itemsRemoved: 0,
      itemsMarkedStale: 0,
    });
    expect(
      state.getAccountView(scope).positions.map((row) => row.symbol),
    ).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('replace-scope position snapshots close missing positions in the same scope', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [
        position({ symbol: 'BTCUSDT' }),
        position({ symbol: 'ETHUSDT', quantity: '1.000' }),
      ],
      source: 'rest',
      asOfMs: 1,
    });
    syncSnapshot(state, {
      scope: otherScope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [position({ ...otherScope, symbol: 'BTCUSDT' })],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [position({ symbol: 'BTCUSDT', quantity: '0.200' })],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
      itemsRemoved: 1,
      itemsMarkedStale: 0,
    });
    expect(state.getAccountView(scope).positions).toEqual([
      position({ symbol: 'BTCUSDT', quantity: '0.200' }),
    ]);
    expect(state.getAccountView(otherScope).positions).toEqual([
      position({ ...otherScope, symbol: 'BTCUSDT' }),
    ]);
  });

  it('replace-symbols only replaces explicitly covered symbols', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [
        position({ symbol: 'BTCUSDT' }),
        position({ symbol: 'ETHUSDT' }),
        position({ symbol: 'SOLUSDT' }),
      ],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'replace-symbols',
      rows: [position({ symbol: 'BTCUSDT', quantity: '0.200' })],
      source: 'rest',
      asOfMs: 2,
      coverage: {
        symbols: ['BTCUSDT', 'ETHUSDT'],
      },
    });

    expect(changeSet).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
      itemsRemoved: 1,
      itemsMarkedStale: 0,
    });
    expect(
      state.getAccountView(scope).positions.map((row) => row.symbol),
    ).toEqual(['BTCUSDT', 'SOLUSDT']);
    expect(state.getAccountView(scope).positions[0].quantity).toBe('0.200');
  });

  it('position side coverage can replace one hedge-mode side without removing the other', () => {
    const state = new ExchangeAccountStateStore();
    const longPosition = position({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'LONG',
      strategySide: 'LONG',
      quantity: '0.100',
    });
    const shortPosition = position({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'SHORT',
      strategySide: 'SHORT',
      quantity: '0.200',
      signedQuantity: '-0.200',
    });

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [longPosition, shortPosition],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'replace-symbols',
      rows: [
        {
          ...longPosition,
          quantity: '0.300',
        },
      ],
      source: 'rest',
      asOfMs: 2,
      coverage: {
        symbols: ['BTCUSDT'],
        positionSides: ['LONG'],
      },
    });

    expect(changeSet).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
      itemsRemoved: 0,
    });
    expect(state.getAccountView(scope).positions).toEqual([
      {
        ...longPosition,
        quantity: '0.300',
      },
      shortPosition,
    ]);
  });

  it('replace-symbols without symbol coverage does not remove existing rows', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [position({ symbol: 'BTCUSDT' })],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'replace-symbols',
      rows: [],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      itemsRemoved: 0,
      itemsMarkedStale: 0,
    });
    expect(state.getAccountView(scope).positions).toEqual([
      position({ symbol: 'BTCUSDT' }),
    ]);
  });

  it('open-order replacement marks absent app-owned orders stale', () => {
    const state = new ExchangeAccountStateStore();
    const appOrder = order({
      exchangeOrderId: '1001',
      customOrderId: 'app-1001',
      owner: 'app',
    });
    const manualOrder = order({
      exchangeOrderId: '1002',
      customOrderId: 'manual-1002',
      owner: 'manual',
    });

    syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [appOrder, manualOrder],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'replace-scope',
      rows: [],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      itemsRemoved: 1,
      itemsMarkedStale: 1,
      confidenceChanged: true,
    });
    expect(state.getAccountView(scope).openOrders).toEqual([
      {
        ...appOrder,
        status: 'stale',
      },
    ]);
    expect(state.getAccountView(scope).confidence.openOrders).toBe('stale');
    expect(state.getAccountView(scope).stateCheckReasons).toContain(
      'openOrders_stale',
    );
    expect(state.getStateChecks(scope)).toContainEqual({
      scope,
      subject: 'openOrders',
      reason: 'stale_state',
      priority: 'immediate',
    });
  });

  it('open-order replacement is limited by symbol and kind coverage', () => {
    const state = new ExchangeAccountStateStore();
    const btcRegular = order({
      symbol: 'BTCUSDT',
      kind: 'regular',
      exchangeOrderId: '1001',
    });
    const btcAlgo = order({
      symbol: 'BTCUSDT',
      kind: 'algo',
      exchangeOrderId: undefined,
      customOrderId: undefined,
      customTriggerOrderId: 'algo-client-1',
    });
    const ethRegular = order({
      symbol: 'ETHUSDT',
      kind: 'regular',
      exchangeOrderId: '1002',
      customOrderId: 'client-1002',
    });

    syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [btcRegular, btcAlgo, ethRegular],
      source: 'rest',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'replace-symbols',
      rows: [],
      source: 'rest',
      asOfMs: 2,
      coverage: {
        symbols: ['BTCUSDT'],
        orderKinds: ['regular'],
      },
    });

    expect(changeSet).toMatchObject({
      itemsRemoved: 1,
      itemsMarkedStale: 0,
    });
    expect(
      state
        .getAccountView(scope)
        .openOrders.map((row) => [row.symbol, row.kind, row.exchangeOrderId]),
    ).toEqual([
      ['BTCUSDT', 'algo', undefined],
      ['ETHUSDT', 'regular', '1002'],
    ]);
  });

  it('order upserts reconcile custom-id-only rows with later exchange ids', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [
        order({
          exchangeOrderId: undefined,
          customOrderId: 'client-1001',
          status: 'provisional',
          source: 'local',
        }),
      ],
      source: 'local',
      asOfMs: 1,
    });

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [
        order({
          exchangeOrderId: '1001',
          customOrderId: 'client-1001',
          status: 'new',
          source: 'rest',
        }),
      ],
      source: 'rest',
      asOfMs: 2,
    });

    expect(changeSet).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
    });
    expect(state.getAccountView(scope).openOrders).toHaveLength(1);
    expect(state.getAccountView(scope).openOrders[0]).toMatchObject({
      exchangeOrderId: '1001',
      customOrderId: 'client-1001',
      status: 'new',
    });
  });

  it('keeps regular custom ids separate from trigger-order custom ids', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'openOrders',
      mode: 'upsert-only',
      rows: [
        order({
          kind: 'regular',
          exchangeOrderId: '1001',
          customOrderId: 'shared-custom-id',
        }),
        order({
          kind: 'algo',
          exchangeOrderId: undefined,
          customOrderId: undefined,
          exchangeTriggerOrderId: 'trigger-1001',
          customTriggerOrderId: 'shared-custom-id',
          type: 'STOP_MARKET',
          side: 'SELL',
        }),
      ],
      source: 'rest',
      asOfMs: 1,
    });

    expect(state.getOpenOrders(scope)).toHaveLength(2);
    expect(
      state.getOrder(scope, { customOrderId: 'shared-custom-id' }),
    ).toMatchObject({ kind: 'regular', exchangeOrderId: '1001' });
    expect(
      state.getOrder(scope, { customTriggerOrderId: 'shared-custom-id' }),
    ).toMatchObject({
      kind: 'algo',
      exchangeTriggerOrderId: 'trigger-1001',
    });

    state.recordOrderNotFound({
      scope,
      identity: { customTriggerOrderId: 'shared-custom-id' },
      reason: 'triggered',
      atMs: 2,
    });

    expect(state.getOpenOrders(scope)).toEqual([
      expect.objectContaining({
        kind: 'regular',
        customOrderId: 'shared-custom-id',
      }),
    ]);
  });

  it('balances and fills upsert and replace by their identities', () => {
    const state = new ExchangeAccountStateStore();

    const balanceChange = syncSnapshot(state, {
      scope,
      subject: 'balances',
      mode: 'upsert-only',
      rows: [balance({ asset: 'USDT' }), balance({ asset: 'BTC' })],
      source: 'rest',
      asOfMs: 1,
    });

    const fillChange = syncSnapshot(state, {
      scope,
      subject: 'fills',
      mode: 'upsert-only',
      rows: [fill({ exchangeTradeId: 'trade-1' })],
      source: 'rest',
      asOfMs: 1,
    });

    expect(balanceChange).toMatchObject({
      itemsAdded: 2,
      itemsUpdated: 0,
    });
    expect(fillChange).toMatchObject({
      itemsAdded: 1,
      itemsUpdated: 0,
    });

    const replaceBalances = syncSnapshot(state, {
      scope,
      subject: 'balances',
      mode: 'replace-scope',
      rows: [balance({ asset: 'USDT', walletBalance: '1200.00' })],
      source: 'rest',
      asOfMs: 2,
    });

    expect(replaceBalances).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
      itemsRemoved: 1,
    });
    expect(state.getAccountView(scope).balances).toEqual([
      balance({ asset: 'USDT', walletBalance: '1200.00' }),
    ]);
    expect(state.getAccountView(scope).fills).toEqual([
      fill({ exchangeTradeId: 'trade-1' }),
    ]);
  });

  it('warns and skips rows that do not match the snapshot subject or scope', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [order(), position({ ...otherScope, symbol: 'ETHUSDT' })],
      source: 'rest',
      asOfMs: 1,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      itemsAdded: 0,
      itemsUpdated: 0,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'snapshot_row_subject_mismatch',
      'snapshot_row_scope_mismatch',
    ]);
    expect(state.getAccountView(scope).positions).toEqual([]);
  });

  it('returns cloned views instead of mutable internal rows', () => {
    const state = new ExchangeAccountStateStore();

    syncSnapshot(state, {
      scope,
      subject: 'positions',
      mode: 'upsert-only',
      rows: [position()],
      source: 'rest',
      asOfMs: 1,
    });

    const view = state.getAccountView(scope);
    view.positions[0].quantity = '999';
    view.scope.accountId = 'mutated';

    expect(state.getAccountView(scope).positions[0].quantity).toBe('0.100');
    expect(state.getAccountView(scope).scope.accountId).toBe('primary');
  });
});

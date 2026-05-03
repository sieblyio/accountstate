import { ExchangeAccountStateStore } from '../../src';
import type {
  AccountScope,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../src';
import type { AccountFact } from '../../src/core';

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

function balance(
  overrides: Partial<NormalizedBalance> = {},
): NormalizedBalance {
  return {
    ...scope,
    asset: 'USDT',
    walletBalance: '1000.00',
    availableBalance: '900.00',
    updatedAtMs: 1,
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
    executedAtMs: 1,
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

function syncRequiredSubjects(state: ExchangeAccountStateStore): void {
  state.setPositions(scope, [position()], { asOfMs: 1 });
  state.setOpenOrders(scope, [], { asOfMs: 1 });
  state.setBalances(scope, [balance()], { asOfMs: 1 });
}

describe('ExchangeAccountStateStore exchange account API', () => {
  it('current-state setters produce the same state as snapshot reducer calls', () => {
    const account = new ExchangeAccountStateStore();
    const reducer = new ExchangeAccountStateStore();

    account.setPositions(scope, [position()], { asOfMs: 1 });
    reducer.ingest({
      type: 'rest_snapshot',
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [position()],
      source: 'rest',
      asOfMs: 1,
    });

    account.setOpenOrders(scope, [order()], { asOfMs: 2 });
    reducer.ingest({
      type: 'rest_snapshot',
      scope,
      subject: 'openOrders',
      mode: 'replace-scope',
      rows: [order()],
      source: 'rest',
      asOfMs: 2,
    });

    account.setBalances(scope, [balance()], { asOfMs: 3 });
    reducer.ingest({
      type: 'rest_snapshot',
      scope,
      subject: 'balances',
      mode: 'replace-scope',
      rows: [balance()],
      source: 'rest',
      asOfMs: 3,
    });

    account.setFills(scope, [fill()], { asOfMs: 4 });
    reducer.ingest({
      type: 'rest_snapshot',
      scope,
      subject: 'fills',
      mode: 'upsert-only',
      rows: [fill()],
      source: 'rest',
      asOfMs: 4,
    });

    expect(account.getAccountView(scope)).toEqual(
      reducer.getAccountView(scope),
    );
  });

  it('WebSocket update helpers produce the same state as stream reducer calls', () => {
    const account = new ExchangeAccountStateStore();
    const reducer = new ExchangeAccountStateStore();
    const streamOrder = order({ source: 'ws', updatedAtMs: 10 });

    account.applyOrderUpdate(scope, streamOrder, {
      receivedAtMs: 11,
      eventId: 'event-1',
    });
    reducer.ingest({
      type: 'order_updated',
      scope,
      order: streamOrder,
      provenance: {
        source: 'ws',
        receivedAtMs: 11,
        eventId: 'event-1',
      },
    });

    account.recordStreamGap(scope, {
      atMs: 12,
      reason: 'missed sequence',
    });
    reducer.ingest({
      type: 'stream_health',
      scope,
      status: 'gap',
      reason: 'missed sequence',
      atMs: 12,
      provenance: {
        source: 'ws',
        receivedAtMs: 12,
      },
    });

    expect(account.getAccountView(scope)).toEqual(
      reducer.getAccountView(scope),
    );
    expect(account.getStateChecks(scope)).toEqual(
      reducer.getStateChecks(scope),
    );
  });

  it('order submission helpers produce the same state as local submission facts', () => {
    const account = new ExchangeAccountStateStore();
    const reducer = new ExchangeAccountStateStore();
    const acceptedOrder = order({
      exchangeOrderId: undefined,
      source: 'local',
    });

    account.recordOrderAccepted({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: acceptedOrder,
      acceptedAtMs: 1,
    });
    reducer.ingest({
      type: 'local_submission_accepted',
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      order: acceptedOrder,
      acceptedAtMs: 1,
    });

    account.recordOrderRejected({
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      rejectedAtMs: 2,
      error: { message: 'duplicate custom order id' },
    });
    reducer.ingest({
      type: 'local_submission_rejected',
      scope,
      intentId: 'intent-1',
      customOrderId: 'client-1001',
      rejectedAtMs: 2,
      error: { message: 'duplicate custom order id' },
    });

    expect(account.getAccountView(scope)).toEqual(
      reducer.getAccountView(scope),
    );
    expect(account.getStateChecks(scope)).toEqual(
      reducer.getStateChecks(scope),
    );
  });

  it('terminal order helpers use exchange-facing language for known identities', () => {
    const state = new ExchangeAccountStateStore();

    state.setOpenOrders(scope, [order()], { asOfMs: 1 });

    const notFoundChange = state.recordOrderNotFound({
      scope,
      identity: { customOrderId: 'client-1001' },
      atMs: 2,
    });

    expect(notFoundChange).toMatchObject({
      changed: true,
      changedSubjects: ['openOrders'],
      itemsRemoved: 1,
      warnings: [],
    });
    expect(state.getAccount(scope).openOrders).toEqual([]);

    state.setOpenOrders(scope, [order()], { asOfMs: 3 });

    const cancelChange = state.recordOrderCancelled({
      scope,
      identity: { exchangeOrderId: '1001' },
      cancelledAtMs: 4,
    });

    expect(cancelChange).toMatchObject({
      changed: true,
      changedSubjects: ['openOrders'],
      itemsRemoved: 1,
      warnings: [],
    });
    expect(state.getAccount(scope).openOrders).toEqual([]);
  });

  it('getAccount exposes conservative readiness without requiring confidence internals', () => {
    const state = new ExchangeAccountStateStore();

    const startup = state.getAccount(scope);
    expect(startup.readyToTrade).toBe(false);
    expect(startup.stateChecks.map((check) => check.subject)).toEqual([
      'positions',
      'openOrders',
      'balances',
      'fills',
    ]);

    state.setPositions(scope, [position()], { asOfMs: 1 });
    state.setOpenOrders(scope, [], { asOfMs: 1 });

    const positionsAndOrders = state.getAccount(scope, {
      requiredSubjects: ['positions', 'openOrders'],
    });
    expect(positionsAndOrders.readyToTrade).toBe(true);
    expect(positionsAndOrders.canTrustPositions).toBe(true);
    expect(positionsAndOrders.canTrustOpenOrders).toBe(true);
    expect(positionsAndOrders.canTrustBalances).toBe(false);
    expect(positionsAndOrders.canTrustFills).toBe(false);
    expect(positionsAndOrders.stateChecks).toEqual([
      { scope, subject: 'balances', reason: 'startup', priority: 'immediate' },
      { scope, subject: 'fills', reason: 'startup', priority: 'background' },
    ]);
    expect(state.getAccount(scope).readyToTrade).toBe(false);

    syncRequiredSubjects(state);

    const synced = state.getAccount(scope);
    expect(synced.readyToTrade).toBe(true);
    expect(synced.canTrustPositions).toBe(true);
    expect(synced.canTrustOpenOrders).toBe(true);
    expect(synced.canTrustBalances).toBe(true);
    expect(synced.canTrustFills).toBe(false);
    expect(synced.stateChecks).toEqual([
      { scope, subject: 'fills', reason: 'startup', priority: 'background' },
    ]);
    const requiresFills = state.getAccount(scope, { requireFills: true });
    expect(requiresFills.readyToTrade).toBe(false);
    expect(requiresFills.stateChecks).toEqual([
      { scope, subject: 'fills', reason: 'startup', priority: 'immediate' },
    ]);
    const explicitlyRequiresFills = state.getAccount(scope, {
      requiredSubjects: ['positions', 'openOrders', 'fills'],
    });
    expect(explicitlyRequiresFills.readyToTrade).toBe(false);
    expect(explicitlyRequiresFills.stateChecks).toEqual([
      { scope, subject: 'fills', reason: 'startup', priority: 'immediate' },
    ]);

    state.setFills(scope, [fill()], { asOfMs: 2 });
    expect(state.getAccount(scope, { requireFills: true }).readyToTrade).toBe(
      true,
    );

    state.recordStreamReconnected(scope, { atMs: 3 });
    const stale = state.getAccount(scope);
    expect(stale.readyToTrade).toBe(false);
    expect(stale.stateChecks).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'stream_reconnected',
          priority: 'immediate',
          detectedAtMs: 3,
        },
      ]),
    );
  });

  it('query helpers read the same account state without exposing internals', () => {
    const state = new ExchangeAccountStateStore();
    const longPosition = position({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'LONG',
      strategySide: 'LONG',
    });
    const shortPosition = position({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'SHORT',
      strategySide: 'SHORT',
      signedQuantity: '-0.100',
    });
    const ethOrder = order({
      symbol: 'ETHUSDT',
      exchangeOrderId: '1002',
      customOrderId: 'client-1002',
      status: 'partially_filled',
    });
    const btcFill = fill({
      symbol: 'BTCUSDT',
      exchangeTradeId: 'trade-1001',
      customOrderId: 'client-1001',
    });

    state.setPositions(scope, [longPosition, shortPosition], { asOfMs: 1 });
    state.setOpenOrders(scope, [order(), ethOrder], { asOfMs: 1 });
    state.setBalances(scope, [balance()], { asOfMs: 1 });
    state.setFills(scope, [btcFill], { asOfMs: 1 });

    expect(state.getPositions(scope)).toEqual(
      state.getAccount(scope).positions,
    );
    expect(state.getPositions(scope, { symbol: 'BTCUSDT' })).toEqual([
      longPosition,
      shortPosition,
    ]);
    expect(state.getPosition(scope, { symbol: 'BTCUSDT' })).toBeUndefined();
    expect(
      state.getPosition(scope, {
        symbol: 'BTCUSDT',
        exchangePositionSide: 'LONG',
      }),
    ).toEqual(longPosition);
    expect(state.getOpenOrders(scope, { symbol: 'ETHUSDT' })).toEqual([
      ethOrder,
    ]);
    expect(state.getOrder(scope, { customOrderId: 'client-1001' })).toEqual(
      order(),
    );
    expect(state.getBalances(scope)).toEqual([balance()]);
    expect(state.getBalance(scope, 'USDT')).toEqual(balance());
    expect(state.getFills(scope, { customOrderId: 'client-1001' })).toEqual([
      btcFill,
    ]);
  });

  it('ingest dispatches supported facts and warns for unsupported planned facts', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest({
      type: 'rest_snapshot',
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [position()],
      source: 'rest',
      asOfMs: 1,
    });
    state.ingest({
      type: 'order_updated',
      scope,
      order: order({ source: 'ws', updatedAtMs: 2 }),
      provenance: {
        source: 'ws',
        receivedAtMs: 2,
      },
    });
    state.ingest({
      type: 'stream_health',
      scope,
      status: 'connected',
      atMs: 3,
    });

    expect(state.getAccountView(scope).positions).toEqual([position()]);
    expect(state.getAccountView(scope).openOrders).toEqual([
      order({ source: 'ws', updatedAtMs: 2 }),
    ]);
    expect(state.getAccountView(scope).confidence.stream).toBe('stream_only');

    const unsupported = state.ingest({
      type: 'operator_state',
      scope,
      status: 'paused',
      atMs: 4,
    });

    expect(unsupported.warnings.map((warning) => warning.name)).toEqual([
      'unsupported_account_fact',
    ]);
  });

  it('ingest dispatches a single fact or replay facts in order', () => {
    const state = new ExchangeAccountStateStore();
    const firstBalance: AccountFact = {
      type: 'rest_snapshot',
      scope,
      subject: 'balances',
      mode: 'replace-scope',
      rows: [balance({ walletBalance: '1000.00' })],
      source: 'rest',
      asOfMs: 1,
    };
    const secondBalance: AccountFact = {
      type: 'rest_snapshot',
      scope,
      subject: 'balances',
      mode: 'replace-scope',
      rows: [balance({ walletBalance: '1200.00' })],
      source: 'rest',
      asOfMs: 2,
    };

    const firstChangeSet = state.ingest(firstBalance);
    const changeSets = state.ingest([secondBalance]);

    expect(firstChangeSet.itemsAdded).toBe(1);
    expect(firstChangeSet.changedSubjects).toEqual(['balances', 'stateChecks']);
    expect(changeSets.map((changeSet) => changeSet.itemsUpdated)).toEqual([1]);
    expect(changeSets.map((changeSet) => changeSet.changedSubjects)).toEqual([
      ['balances', 'stateChecks'],
    ]);
    expect(state.getAccount(scope).balances).toEqual([
      balance({ walletBalance: '1200.00' }),
    ]);
  });
});

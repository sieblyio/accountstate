import { ExchangeAccountStateStore } from '../../../src/core/ExchangeAccountStateStore';
import {
  areBinanceManagedOrdersEquivalent,
  binance,
  binanceAccountStateFixtures,
  binanceRawSamples,
  binanceUsdmClosePositionStopComparisonPolicy,
  binanceUsdmOrderDefaultsComparisonPolicy,
  classifyBinanceSubmissionError,
  createBinanceManagedOrderParser,
  explainBinanceManagedOrderDiff,
  isBinanceUnknownOrderError,
  normalizeBinanceUsdmAccountUpdate,
  normalizeBinanceUsdmOpenAlgoOrder,
  normalizeBinanceUsdmOrderTradeUpdate,
  normalizeBinanceUsdmPosition,
  normalizeBinanceUsdmRegularOpenOrder,
} from '../../../src/adapters/binance';
import { runAccountStateFixtures } from '../../../src/conformance';
import type { AccountScope, NormalizedOrder } from '../../../src/core';
import type {
  BinanceUsdmAlgoUpdateEvent,
  BinanceUsdmAccountUpdateEvent,
  BinanceUsdmOpenAlgoOrderRow,
  BinanceUsdmOrderTradeUpdateEvent,
  BinanceUsdmPositionRow,
  BinanceUsdmRegularOpenOrderRow,
} from '../../../src/adapters/binance';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

describe('Binance adapter normalizers', () => {
  it('passes the sample-backed Binance fixture pack', () => {
    const results = runAccountStateFixtures({
      fixtures: binanceAccountStateFixtures,
    });

    expect(
      results.map((result) => ({
        name: result.fixture.name,
        passed: result.passed,
        failures: result.failures,
      })),
    ).toEqual(
      binanceAccountStateFixtures.map((fixture) => ({
        name: fixture.name,
        passed: true,
        failures: [] as [],
      })),
    );
  });

  it('normalizes one-way BOTH positions from signed quantity', () => {
    expect(
      normalizeBinanceUsdmPosition(
        usdmPosition({ positionAmt: '0.25', positionSide: 'BOTH' }),
        scope,
      ),
    ).toMatchObject({
      symbol: 'BTCUSDT',
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
      quantity: '0.25',
      signedQuantity: '0.25',
    });

    expect(
      normalizeBinanceUsdmPosition(
        usdmPosition({ positionAmt: '-0.30', positionSide: 'BOTH' }),
        scope,
      ),
    ).toMatchObject({
      strategySide: 'SHORT',
      quantity: '0.30',
      signedQuantity: '-0.30',
    });
  });

  it('normalizes hedge LONG and SHORT positions directly', () => {
    expect(
      normalizeBinanceUsdmPosition(
        usdmPosition({ positionAmt: '0.10', positionSide: 'LONG' }),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'LONG',
      strategySide: 'LONG',
    });

    expect(
      normalizeBinanceUsdmPosition(
        usdmPosition({ positionAmt: '-0.10', positionSide: 'SHORT' }),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'SHORT',
      strategySide: 'SHORT',
      quantity: '0.10',
    });
  });

  it('maps USD-M regular and Algo order custom ids', () => {
    expect(
      normalizeBinanceUsdmRegularOpenOrder(
        regularOrder({ clientOrderId: 'dca-client-1' }),
        scope,
      ),
    ).toMatchObject({
      kind: 'regular',
      exchangeOrderId: '1001',
      customOrderId: 'dca-client-1',
      status: 'new',
    });

    expect(
      normalizeBinanceUsdmOpenAlgoOrder(
        algoOrder({ clientAlgoId: 'sl-client-1' }),
        scope,
      ),
    ).toMatchObject({
      kind: 'algo',
      exchangeTriggerOrderId: '2001',
      customTriggerOrderId: 'sl-client-1',
      status: 'new',
    });
  });

  it('normalizes ORDER_TRADE_UPDATE into order and fill facts', () => {
    const facts = normalizeBinanceUsdmOrderTradeUpdate(
      orderTradeUpdate({
        executionType: 'TRADE',
        orderStatus: 'PARTIALLY_FILLED',
        lastFilledQuantity: 0.05,
        orderFilledAccumulatedQuantity: 0.05,
      }),
      scope,
    );

    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      type: 'order_updated',
      order: {
        exchangeOrderId: '1001',
        customOrderId: 'client-1001',
        status: 'partially_filled',
      },
    });
    expect(facts[1]).toMatchObject({
      type: 'trade_executed',
      fill: {
        exchangeTradeId: '9001',
        exchangeOrderId: '1001',
        customOrderId: 'client-1001',
        quantity: '0.05',
      },
    });
  });

  it('normalizes ACCOUNT_UPDATE into balance and position facts', () => {
    const facts = normalizeBinanceUsdmAccountUpdate(
      binanceRawSamples.userDataAccountUpdateOpenPosition as unknown as BinanceUsdmAccountUpdateEvent,
      scope,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        type: 'balance_updated',
        balance: expect.objectContaining({
          asset: 'BNFCR',
          walletBalance: '465.90189305',
          availableBalance: '465.90189305',
        }),
      }),
      expect.objectContaining({
        type: 'position_updated',
        position: expect.objectContaining({
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'SHORT',
          quantity: '0.005',
          signedQuantity: '-0.005',
        }),
      }),
    ]);
  });

  it('normalizes TRIGGERED ALGO_UPDATE as terminal evidence for the Algo row', () => {
    const facts = binance.ws.userDataEvent(
      scope,
      binanceRawSamples.userDataAlgoTriggered as unknown as BinanceUsdmAlgoUpdateEvent,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        type: 'terminal_evidence',
        identity: {
          customTriggerOrderId: 'x-15PC4ZJyATmom1v3ns',
          exchangeTriggerOrderId: '3000001400283750',
        },
        reason: 'triggered',
      }),
    ]);
    expect(facts[0]).toMatchObject({
      identity: expect.not.objectContaining({
        exchangeOrderId: '1000517687',
      }),
    });
  });

  it('normalizes terminal ALGO_UPDATE statuses into terminal evidence', () => {
    const facts = binance.ws.userDataEvent(
      scope,
      algoUpdate({ algoStatus: 'CANCELED' }),
    );

    expect(facts).toEqual([
      expect.objectContaining({
        type: 'terminal_evidence',
        identity: {
          customTriggerOrderId: 'algo-client-1',
          exchangeTriggerOrderId: '2001',
        },
        reason: 'cancelled',
      }),
    ]);
  });

  it('returns store-ingestable REST and WS facts through the namespaced helper', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      binance.rest.positions(scope, [
        usdmPosition({ positionAmt: '0.20', positionSide: 'BOTH' }),
      ]),
    );
    state.ingest(
      binance.rest.openOrders(scope, [
        regularOrder({ clientOrderId: 'strategy-1:DCA:1:epoch-1:0:BOTH:LONG' }),
      ]),
    );
    state.ingest(
      binance.ws.userDataEvent(
        scope,
        orderTradeUpdate({
          executionType: 'CANCELED',
          orderStatus: 'CANCELED',
          lastFilledQuantity: 0,
        }),
      ),
    );

    expect(state.getPositions(scope)).toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT', strategySide: 'LONG' }),
    ]);
    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('uses caller-supplied parsers for app-specific Binance custom ids', () => {
    const parser = createBinanceManagedOrderParser((customId, order) => ({
      strategyId: customId.split('-')[0],
      role: order.kind === 'algo' ? 'SL' : 'DCA',
    }));

    expect(
      parser.parse({
        ...normalizedAlgoOrder({ customTriggerOrderId: 'strategy-1-stop' }),
      }),
    ).toEqual({ strategyId: 'strategy', role: 'SL' });
  });

  it('filters zero-position REST rows so they close the existing position', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      binance.rest.positions(scope, [
        usdmPosition({ positionAmt: '0.20', positionSide: 'BOTH' }),
      ]),
    );
    state.ingest(
      binance.rest.positions(scope, [
        usdmPosition({ positionAmt: '0', positionSide: 'BOTH' }),
      ]),
    );

    expect(state.getPositions(scope)).toEqual([]);
  });

  it('uses zero-position WebSocket updates to close the existing position', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      binance.rest.positions(scope, [
        usdmPosition({ positionAmt: '0.20', positionSide: 'BOTH' }),
      ]),
    );
    state.ingest(
      binance.ws.userDataEvent(
        scope,
        accountUpdate({ positionAmount: 0, positionSide: 'BOTH' }),
      ),
    );

    expect(state.getPositions(scope)).toEqual([]);
  });

  it('classifies unknown-order errors', () => {
    const error = binanceRawSamples.realUnknownOrderError;

    expect(isBinanceUnknownOrderError(error)).toBe(true);
    expect(classifyBinanceSubmissionError(error)).toEqual({
      message: 'Unknown order sent.',
      code: -2011,
      retryable: false,
      raw: error,
    });
  });

  it('treats Binance close-position stop defaults as equivalent', () => {
    const desired = normalizedAlgoOrder({
      quantity: undefined,
      price: undefined,
      closePosition: true,
      reduceOnly: undefined,
    });
    const active = normalizedAlgoOrder({
      quantity: '0',
      price: '0',
      closePosition: true,
      reduceOnly: false,
    });

    expect(
      binanceUsdmClosePositionStopComparisonPolicy.equivalent(
        desired,
        active,
        {},
      ),
    ).toEqual({ equivalent: true });
    expect(areBinanceManagedOrdersEquivalent({ desired, active })).toBe(true);
  });

  it('treats Binance close-position quantity canonicalization as equivalent', () => {
    const active = normalizeBinanceUsdmOpenAlgoOrder(
      binanceRawSamples.restClosePositionQuantityCanonicalizedAlgo as unknown as BinanceUsdmOpenAlgoOrderRow,
      scope,
    );
    const desired = normalizedAlgoOrder({
      symbol: 'BRUSDT',
      customTriggerOrderId: 'x-15PC4ZJyCPQmom2a88xERR',
      side: 'SELL',
      type: 'STOP_MARKET',
      exchangePositionSide: 'LONG',
      strategySide: 'LONG',
      quantity: '145',
      triggerPrice: '0.08585',
      closePosition: true,
      workingType: 'MARK_PRICE',
      priceProtect: true,
    });

    expect(explainBinanceManagedOrderDiff({ desired, active })).toEqual({
      equivalent: true,
    });
  });

  it('treats common Binance order echo defaults as equivalent', () => {
    const desired = normalizedRegularOrder({
      triggerPrice: undefined,
      reduceOnly: undefined,
      closePosition: undefined,
      timeInForce: undefined,
      workingType: undefined,
      priceProtect: undefined,
    });
    const active = normalizedRegularOrder({
      triggerPrice: '0',
      reduceOnly: false,
      closePosition: false,
      timeInForce: 'GTC',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
    });

    expect(
      binanceUsdmOrderDefaultsComparisonPolicy.equivalent(desired, active, {}),
    ).toEqual({ equivalent: true });
    expect(areBinanceManagedOrdersEquivalent({ desired, active })).toBe(true);
  });

  it('does not hide meaningful Binance order differences', () => {
    const desired = normalizedRegularOrder({ price: '49000.00' });
    const active = normalizedRegularOrder({ price: '49100.00' });

    expect(explainBinanceManagedOrderDiff({ desired, active })).toEqual({
      equivalent: false,
      reason: 'orders differ outside Binance exchange defaults',
      differences: ['price'],
    });
  });

  it('treats provisional accepted Binance orders as satisfying desired state', () => {
    const desired = normalizedRegularOrder({ status: 'new' });
    const active = normalizedRegularOrder({
      status: 'provisional',
      source: 'local',
    });

    expect(areBinanceManagedOrdersEquivalent({ desired, active })).toBe(true);
  });

  it('uses managed metadata when comparing Binance position sides', () => {
    const desired = normalizedAlgoOrder({
      exchangePositionSide: undefined,
      strategySide: undefined,
      metadata: {
        strategyId: 'strategy-1',
        role: 'TP',
        exchangePositionSide: 'SHORT',
        strategySide: 'SHORT',
      },
      type: 'TAKE_PROFIT',
      reduceOnly: undefined,
      closePosition: false,
    });
    const active = normalizedAlgoOrder({
      exchangePositionSide: 'SHORT',
      strategySide: 'SHORT',
      type: 'TAKE_PROFIT',
      reduceOnly: true,
      closePosition: false,
    });

    expect(areBinanceManagedOrdersEquivalent({ desired, active })).toBe(true);
  });
});

function usdmPosition(
  overrides: Partial<BinanceUsdmPositionRow> = {},
): BinanceUsdmPositionRow {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    positionAmt: '0.100',
    entryPrice: '50000.00',
    breakEvenPrice: '50000.00',
    markPrice: '51000.00',
    unRealizedProfit: '100.00',
    liquidationPrice: '25000.00',
    isolatedMargin: '0',
    notional: '5000.00',
    marginAsset: 'USDT',
    isolatedWallet: '0',
    initialMargin: '100.00',
    maintMargin: '10.00',
    positionInitialMargin: '100.00',
    openOrderInitialMargin: '0',
    adl: 1,
    bidNotional: '0',
    askNotional: '0',
    updateTime: 1_700_000_000_000,
    ...overrides,
  };
}

function regularOrder(
  overrides: Partial<BinanceUsdmRegularOpenOrderRow> = {},
): BinanceUsdmRegularOpenOrderRow {
  return {
    avgPrice: '0',
    clientOrderId: 'client-1001',
    cumQuote: '0',
    executedQty: '0',
    orderId: 1001,
    origQty: '0.100',
    origType: 'LIMIT',
    price: '49000.00',
    reduceOnly: false,
    side: 'BUY',
    positionSide: 'BOTH',
    status: 'NEW',
    stopPrice: '0',
    closePosition: false,
    symbol: 'BTCUSDT',
    time: 1_700_000_000_000,
    timeInForce: 'GTC',
    type: 'LIMIT',
    activatePrice: '0',
    priceRate: '0',
    updateTime: 1_700_000_000_100,
    workingType: 'CONTRACT_PRICE',
    priceProtect: false,
    selfTradePreventionMode: 'NONE',
    priceMatch: 'NONE',
    goodTillDate: 0,
    ...overrides,
  };
}

function algoOrder(
  overrides: Partial<BinanceUsdmOpenAlgoOrderRow> = {},
): BinanceUsdmOpenAlgoOrderRow {
  return {
    algoId: 2001,
    clientAlgoId: 'algo-client-1',
    algoType: 'CONDITIONAL',
    orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT',
    side: 'SELL',
    positionSide: 'BOTH',
    timeInForce: 'GTE_GTC',
    quantity: '0',
    algoStatus: 'NEW',
    triggerPrice: '48000.00',
    price: '0',
    icebergQuantity: null,
    selfTradePreventionMode: 'NONE',
    workingType: 'MARK_PRICE',
    priceMatch: 'NONE',
    closePosition: true,
    priceProtect: false,
    reduceOnly: false,
    activatePrice: undefined,
    callbackRate: undefined,
    createTime: 1_700_000_000_000,
    updateTime: 1_700_000_000_100,
    triggerTime: 0,
    goodTillDate: 0,
    ...overrides,
  };
}

function orderTradeUpdate(
  overrides: Partial<BinanceUsdmOrderTradeUpdateEvent['order']> = {},
): BinanceUsdmOrderTradeUpdateEvent {
  return {
    wsMarket: 'usdm',
    wsKey: 'usdmPrivate',
    streamName: 'listen-key',
    eventType: 'ORDER_TRADE_UPDATE',
    eventTime: 1_700_000_000_200,
    transactionTime: 1_700_000_000_210,
    order: {
      symbol: 'BTCUSDT',
      clientOrderId: 'client-1001',
      orderSide: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      originalQuantity: 0.1,
      originalPrice: 49000,
      averagePrice: 49000,
      stopPrice: 0,
      executionType: 'NEW',
      orderStatus: 'NEW',
      orderId: 1001,
      lastFilledQuantity: 0,
      orderFilledAccumulatedQuantity: 0,
      lastFilledPrice: 0,
      commissionAsset: 'USDT',
      commissionAmount: 0,
      orderTradeTime: 1_700_000_000_210,
      tradeId: 9001,
      bidsNotional: 0,
      asksNotional: 0,
      isMakerTrade: false,
      isReduceOnly: false,
      stopPriceWorkingType: 'CONTRACT_PRICE',
      originalOrderType: 'LIMIT',
      positionSide: 'BOTH',
      isCloseAll: false,
      realisedProfit: 0,
      ...overrides,
    },
  };
}

function algoUpdate(
  overrides: Partial<BinanceUsdmAlgoUpdateEvent['algoOrder']> = {},
): BinanceUsdmAlgoUpdateEvent {
  return {
    wsMarket: 'usdm',
    wsKey: 'usdmPrivate',
    streamName: 'listen-key',
    eventType: 'ALGO_UPDATE',
    eventTime: 1_700_000_000_200,
    transactionTime: 1_700_000_000_210,
    algoOrder: {
      clientAlgoId: 'algo-client-1',
      algoId: 2001,
      algoType: 'CONDITIONAL',
      orderType: 'STOP_MARKET',
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'BOTH',
      timeInForce: 'GTE_GTC',
      quantity: '0',
      algoStatus: 'NEW',
      orderId: '0',
      averagePrice: '0',
      executedQty: '0',
      actualOrderType: '0',
      triggerPrice: '48000.00',
      price: '0',
      selfTradePreventionMode: 'NONE',
      workingType: 'MARK_PRICE',
      priceMatch: 'NONE',
      closePosition: true,
      priceProtect: false,
      reduceOnly: false,
      triggerTime: 0,
      goodTillDate: 0,
      ...overrides,
    },
  };
}

function accountUpdate(
  positionOverrides: Partial<
    BinanceUsdmAccountUpdateEvent['updateData']['updatedPositions'][number]
  > = {},
): BinanceUsdmAccountUpdateEvent {
  return {
    wsMarket: 'usdm',
    wsKey: 'usdmPrivate',
    streamName: 'listen-key',
    eventType: 'ACCOUNT_UPDATE',
    eventTime: 1_700_000_000_200,
    transactionTime: 1_700_000_000_210,
    updateData: {
      updateEventType: 'ORDER',
      updatedBalances: [],
      updatedPositions: [
        {
          symbol: 'BTCUSDT',
          marginAsset: 'USDT',
          positionAmount: 0.2,
          entryPrice: 50000,
          accumulatedRealisedPreFee: 0,
          unrealisedPnl: 0,
          marginType: 'cross',
          isolatedWalletAmount: 0,
          positionSide: 'BOTH',
          ...positionOverrides,
        },
      ],
    },
  };
}

function normalizedAlgoOrder(
  overrides: Partial<NormalizedOrder> = {},
): NormalizedOrder {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'algo',
    customTriggerOrderId: 'algo-client-1',
    side: 'SELL',
    type: 'STOP_MARKET',
    status: 'new',
    triggerPrice: '48000.00',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

function normalizedRegularOrder(
  overrides: Partial<NormalizedOrder> = {},
): NormalizedOrder {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'regular',
    customOrderId: 'regular-client-1',
    side: 'BUY',
    type: 'LIMIT',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '0.100',
    price: '49000.00',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

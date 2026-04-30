import { AccountStateStore } from '../../src/AccountStateStore';
import { EngineOrder } from '../../src/lib/types/order';
import {
  EnginePositionSide,
  EngineSimplePosition,
} from '../../src/lib/types/position';

interface TestMetadata {
  leaderId: string;
  entryCount: number;
  trailingEnabled?: boolean;
}

function position(
  overrides: Partial<EngineSimplePosition> = {},
): EngineSimplePosition {
  const side = overrides.positionSide ?? 'LONG';

  return {
    symbol: 'BTCUSDT',
    timestampMs: 1_700_000_000_000,
    positionSide: side,
    orderPositionSide: side === 'NONE' ? 'BOTH' : side,
    positionPrice: 50_000,
    assetQty: 0.1,
    value: 5_000,
    valueUpnl: 0,
    marginValue: 500,
    liquidationPrice: 40_000,
    stopLossPrice: undefined,
    takeProfitPrice: undefined,
    ...overrides,
  };
}

function order(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    exchangeOrderId: '1001',
    customOrderId: 'client-1001',
    symbol: 'BTCUSDT',
    orderSide: 'BUY',
    positionSide: 'LONG',
    orderType: 'LIMIT',
    status: 'NEW',
    price: 49_000,
    originalQuantity: 0.2,
    executedQuantity: 0,
    averagePrice: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    isreduceOnly: false,
    ...overrides,
  };
}

describe('AccountStateStore legacy cache behavior', () => {
  it('tracks current and previous wallet balance', () => {
    const state = new AccountStateStore();

    expect(state.getWalletBalance()).toBe(0);
    expect(state.getPreviousBalance()).toBe(0);

    state.setWalletBalance(10_000);
    state.storePreviousBalance();
    state.setWalletBalance(10_250);

    expect(state.getWalletBalance()).toBe(10_250);
    expect(state.getPreviousBalance()).toBe(10_000);
  });

  it('stores active positions by symbol and side and excludes zero-quantity rows from active lists', () => {
    const state = new AccountStateStore();
    const longPosition = position({ symbol: 'BTCUSDT', positionSide: 'LONG' });
    const shortPosition = position({
      symbol: 'ETHUSDT',
      positionSide: 'SHORT',
      orderPositionSide: 'SHORT',
      assetQty: -2,
    });
    const flatPosition = position({
      symbol: 'XRPUSDT',
      positionSide: 'LONG',
      assetQty: 0,
    });

    state.setActivePosition('BTCUSDT', 'LONG', longPosition);
    state.setActivePosition('ETHUSDT', 'SHORT', shortPosition);
    state.setActivePosition('XRPUSDT', 'LONG', flatPosition);

    expect(state.getActivePosition('BTCUSDT', 'LONG')).toBe(longPosition);
    expect(state.isSymbolSideInPosition('BTCUSDT', 'LONG')).toBe(true);
    expect(state.isSymbolSideInPosition('BTCUSDT', 'SHORT')).toBe(false);
    expect(state.isSymbolInAnyPosition('ETHUSDT')).toBe(true);
    expect(state.isSymbolInAnyPosition('XRPUSDT')).toBe(false);
    expect(state.getAllPositions()).toEqual([longPosition, shortPosition]);

    state.deleteActivePosition('BTCUSDT', 'LONG');

    expect(state.getActivePosition('BTCUSDT', 'LONG')).toBeUndefined();
    expect(state.isSymbolInAnyPosition('BTCUSDT')).toBe(false);
  });

  it('recalculates total active and hedged position counts', () => {
    const state = new AccountStateStore();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    state.setActivePosition(
      'BTCUSDT',
      'LONG',
      position({ symbol: 'BTCUSDT', positionSide: 'LONG' }),
    );
    state.setActivePosition(
      'BTCUSDT',
      'SHORT',
      position({
        symbol: 'BTCUSDT',
        positionSide: 'SHORT',
        orderPositionSide: 'SHORT',
        assetQty: -0.2,
      }),
    );
    state.setActivePosition(
      'ETHUSDT',
      'LONG',
      position({ symbol: 'ETHUSDT', positionSide: 'LONG' }),
    );

    expect(state.getTotalHedgedPositions()).toBe(0);
    expect(state.getTotalActivePositions()).toEqual({
      total: 3,
      totalHedged: 1,
    });
    expect(state.getTotalHedgedPositions()).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      'BTCUSDT has a long and short position!',
    );

    logSpy.mockRestore();
  });

  it('does not count NONE plus one directional position as hedged', () => {
    const state = new AccountStateStore();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    state.setActivePosition(
      'BTCUSDT',
      'LONG',
      position({ symbol: 'BTCUSDT', positionSide: 'LONG' }),
    );
    state.setActivePosition(
      'BTCUSDT',
      'NONE',
      position({
        symbol: 'BTCUSDT',
        positionSide: 'NONE',
        orderPositionSide: 'BOTH',
      }),
    );

    expect(state.getTotalActivePositions()).toEqual({
      total: 2,
      totalHedged: 0,
    });
    expect(state.getTotalHedgedPositions()).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('updates position unrealised PnL from price events', () => {
    const state = new AccountStateStore();
    const longPosition = position({
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      positionPrice: 100,
      assetQty: 2,
    });
    const shortPosition = position({
      symbol: 'BTCUSDT',
      positionSide: 'SHORT',
      orderPositionSide: 'SHORT',
      positionPrice: 110,
      assetQty: -1,
    });

    state.setActivePosition('BTCUSDT', 'LONG', longPosition);
    state.setActivePosition('BTCUSDT', 'SHORT', shortPosition);

    state.processPriceEvent({ symbol: 'BTCUSDT', price: 105 });

    expect(longPosition.valueUpnl).toBe(10);
    expect(shortPosition.valueUpnl).toBe(5);
  });

  it('tracks symbol leverage without copying the leverage cache', () => {
    const state = new AccountStateStore();

    state.setSymbolLeverage('BTCUSDT', 10);

    const cache = state.getSymbolLeverageCache();
    cache.ETHUSDT = 5;

    expect(state.getSymbolLeverage('BTCUSDT')).toBe(10);
    expect(state.getSymbolLeverage('ETHUSDT')).toBe(5);
  });

  it('stores metadata and marks metadata mutations as pending persistence', () => {
    const state = new AccountStateStore<TestMetadata>();

    expect(state.isPendingPersist()).toBe(false);

    state.setSymbolMetadata('BTCUSDT', {
      leaderId: 'leader-1',
      entryCount: 1,
    });

    expect(state.getSymbolMetadata('BTCUSDT')).toEqual({
      leaderId: 'leader-1',
      entryCount: 1,
    });
    expect(state.getSymbolsWithMetadata()).toEqual(['BTCUSDT']);
    expect(state.isPendingPersist()).toBe(true);

    state.setIsPendingPersist(false);
    state.setSymbolMetadataValue('BTCUSDT', 'entryCount', 2);

    expect(state.getSymbolMetadata('BTCUSDT')?.entryCount).toBe(2);
    expect(state.isPendingPersist()).toBe(true);

    state.setIsPendingPersist(false);
    state.deletePositionMetadata('BTCUSDT');

    expect(state.getSymbolMetadata('BTCUSDT')).toBeUndefined();
    expect(state.isPendingPersist()).toBe(true);
  });

  it('throws when setting a metadata value before symbol metadata is initialised', () => {
    const state = new AccountStateStore<TestMetadata>();

    expect(() =>
      state.setSymbolMetadataValue('BTCUSDT', 'entryCount', 1),
    ).toThrow(
      'Symbol metadata not initilised. Prepare full metadata state via setSymbolMetadata() before using the setSymbolMetadataValue() method!',
    );
  });

  it('overwrites all metadata without toggling the pending persistence flag', () => {
    const state = new AccountStateStore<TestMetadata>();

    state.setAllSymbolMetadata({
      BTCUSDT: { leaderId: 'leader-1', entryCount: 1 },
      ETHUSDT: { leaderId: 'leader-2', entryCount: 3 },
    });

    expect(state.getAllSymbolMetadata()).toEqual({
      BTCUSDT: { leaderId: 'leader-1', entryCount: 1 },
      ETHUSDT: { leaderId: 'leader-2', entryCount: 3 },
    });
    expect(state.getSymbolsWithMetadata()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(state.isPendingPersist()).toBe(false);
  });

  it('stores only active orders and removes terminal orders by exchange order id', () => {
    const state = new AccountStateStore();
    const newOrder = order({ exchangeOrderId: '1001', status: 'NEW' });
    const partiallyFilledOrder = order({
      exchangeOrderId: '1002',
      customOrderId: 'client-1002',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 0.1,
    });

    state.upsertActiveOrder(newOrder);
    state.upsertActiveOrder(partiallyFilledOrder);

    expect(state.getOrders()).toEqual([newOrder, partiallyFilledOrder]);
    expect(state.getActiveOrders()).toEqual([newOrder, partiallyFilledOrder]);
    expect(state.getOrder('1001')).toBe(newOrder);

    state.upsertActiveOrder({
      ...newOrder,
      status: 'FILLED',
      executedQuantity: 0.2,
      averagePrice: 49_000,
    });

    expect(state.getOrder('1001')).toBeUndefined();
    expect(state.getOrders()).toEqual([partiallyFilledOrder]);

    state.deleteOrder('1002');
    expect(state.getOrders()).toEqual([]);
  });

  it('filters and sorts stored orders', () => {
    const state = new AccountStateStore();
    const btcBuy = order({
      exchangeOrderId: 'b',
      customOrderId: 'client-b',
      symbol: 'BTCUSDT',
      orderSide: 'BUY',
      orderType: 'LIMIT',
      price: 50_000,
      createdAtMs: 20,
    });
    const ethSell = order({
      exchangeOrderId: 'a',
      customOrderId: 'client-a',
      symbol: 'ETHUSDT',
      orderSide: 'SELL',
      positionSide: 'SHORT',
      orderType: 'STOP_MARKET',
      price: 3_000,
      createdAtMs: 10,
    });
    const btcSell = order({
      exchangeOrderId: 'c',
      customOrderId: 'client-c',
      symbol: 'BTCUSDT',
      orderSide: 'SELL',
      positionSide: 'SHORT',
      orderType: 'LIMIT',
      price: 51_000,
      createdAtMs: 30,
    });

    state.upsertActiveOrder(btcBuy);
    state.upsertActiveOrder(ethSell);
    state.upsertActiveOrder(btcSell);

    expect(state.getOrdersForSymbol('BTCUSDT')).toEqual([btcBuy, btcSell]);
    expect(state.getOrdersForSymbolSide('BTCUSDT', 'SELL')).toEqual([btcSell]);
    expect(state.getOrdersByStatus('NEW')).toEqual([btcBuy, ethSell, btcSell]);
    expect(state.getOrdersByType('LIMIT')).toEqual([btcBuy, btcSell]);
    expect(
      state.getOrdersSortedById().map((item) => item.exchangeOrderId),
    ).toEqual(['a', 'b', 'c']);
    expect(
      state.getOrdersSortedByPrice(false).map((item) => item.exchangeOrderId),
    ).toEqual(['c', 'b', 'a']);
    expect(
      state
        .getOrdersForSymbolSortedByPrice('BTCUSDT')
        .map((item) => item.exchangeOrderId),
    ).toEqual(['b', 'c']);
    expect(
      state
        .getOrdersForSymbolSideSortedByPrice('BTCUSDT', 'SELL')
        .map((item) => item.exchangeOrderId),
    ).toEqual(['c']);
    expect(
      state.getOrdersSortedByTimestamp().map((item) => item.exchangeOrderId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('produces the current session summary shape and calculations', () => {
    const state = new AccountStateStore();

    state.setWalletBalance(10_500);
    state.setSymbolLeverage('BTCUSDT', 10);
    state.setActivePosition(
      'BTCUSDT',
      'LONG',
      position({
        symbol: 'BTCUSDT',
        positionSide: 'LONG',
        valueUpnl: 250,
        marginValue: 1_000,
      }),
    );

    expect(state.getSessionSummary(10_000)).toEqual({
      activePositions: [
        {
          ...position({
            symbol: 'BTCUSDT',
            positionSide: 'LONG',
            valueUpnl: 250,
            marginValue: 1_000,
          }),
          leverage: 10,
        },
      ],
      activePositionUpnlSum: 250,
      account: {
        quoteBalanceState: {
          startedWith: 10_000,
          now: 10_500,
          quoteMarginLockedSum: 1_000,
          nowInclLocked: 9_000,
          nowIfEverythingClosedAtMarket: 10_250,
        },
        pnlState: {
          realisedPnl: 500,
          unrealisedPnl: 250,
        },
      },
    });
  });

  it('keeps the current dual-position-mode response', () => {
    const state = new AccountStateStore();

    expect(state.isDualPositionMode()).toBe(true);
  });

  it.each<EnginePositionSide>(['LONG', 'SHORT', 'NONE'])(
    'initialises missing %s position slots when queried',
    (side) => {
      const state = new AccountStateStore();

      expect(state.getActivePosition('BTCUSDT', side)).toBeUndefined();
    },
  );
});

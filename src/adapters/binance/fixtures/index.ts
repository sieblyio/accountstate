import type { AccountStateFixture } from '../../../fixtures/types.js';
import type {
  AccountScope,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../core/types.js';
import { binance } from '../normalize.js';
import type {
  BinanceUsdmAccountUpdateEvent,
  BinanceUsdmAlgoUpdateEvent,
  BinanceUsdmOpenAlgoOrderRow,
  BinanceUsdmOrderTradeUpdateEvent,
  BinanceUsdmPositionRow,
  BinanceUsdmRegularOpenOrderRow,
} from '../types.js';
import { binanceRawSamples } from './raw.js';

export { binanceRawSamples } from './raw.js';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'sample',
  product: 'usdm',
  environment: 'mainnet',
};

/**
 * Sample-backed Binance USD-M fixtures built from sanitized captured payloads.
 */
export const binanceAccountStateFixtures = [
  {
    name: 'binance-usdm-rest-hedge-snapshot',
    description:
      'REST snapshots map hedge LONG/SHORT positions plus regular and Algo open orders.',
    facts: [
      binance.rest.positions(scope, [
        positionRow(binanceRawSamples.restHedgeLongPosition),
        positionRow(binanceRawSamples.restHedgeShortPosition),
      ]),
      binance.rest.openOrders(scope, [
        regularOrderRow(binanceRawSamples.restHedgeRegularOpenOrder),
      ]),
      binance.rest.openAlgoOrders(scope, [
        algoOrderRow(binanceRawSamples.restHedgeTakeProfitAlgo),
        algoOrderRow(binanceRawSamples.restHedgeClosePositionStopAlgo),
      ]),
    ],
    expect: {
      positions: [
        {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'LONG',
          strategySide: 'LONG',
          quantity: '0.004',
          signedQuantity: '0.004',
        },
        {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'SHORT',
          strategySide: 'SHORT',
          quantity: '0.003',
          signedQuantity: '-0.003',
        },
      ],
      openOrders: [
        {
          kind: 'regular',
          exchangeOrderId: '1000252371396',
          customOrderId: 'x-15PC4ZJyPM-U-L-L-D-01-L1-0',
          exchangePositionSide: 'LONG',
          strategySide: 'LONG',
        },
        {
          kind: 'algo',
          customTriggerOrderId: 'x-15PC4ZJyPM-U-L-L-T-01-L1-0',
          type: 'TAKE_PROFIT',
          closePosition: false,
          reduceOnly: true,
        },
        {
          kind: 'algo',
          customTriggerOrderId: 'x-15PC4ZJyPM-U-L-L-X-01-L1-0',
          type: 'STOP_MARKET',
          closePosition: true,
          reduceOnly: true,
          quantity: '0.0',
        },
      ],
      confidence: {
        positions: 'synced',
        openOrders: 'synced',
      },
    },
  },
  {
    name: 'binance-usdm-rest-one-way-short',
    description:
      'REST snapshots map one-way BOTH plus negative positionAmt to strategy SHORT.',
    facts: [
      binance.rest.positions(scope, [
        positionRow(binanceRawSamples.restOneWayShortPosition),
      ]),
    ],
    expect: {
      positions: [
        {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'SHORT',
          quantity: '0.005',
          signedQuantity: '-0.005',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-account-update-opens-position-and-updates-balance',
    description:
      'ACCOUNT_UPDATE maps Binance USD-M websocket balance and position updates.',
    facts: [
      ...binance.ws.privateEvent(
        scope,
        accountUpdateEvent(binanceRawSamples.userDataAccountUpdateOpenPosition),
      ),
    ],
    expect: {
      positions: [
        {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'SHORT',
          quantity: '0.005',
          signedQuantity: '-0.005',
        },
      ],
      balances: [
        {
          asset: 'BNFCR',
          walletBalance: '465.90189305',
          availableBalance: '465.90189305',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-rest-partially-filled-open-order',
    description:
      'REST open-order snapshot keeps PARTIALLY_FILLED orders open with executed quantity.',
    facts: [
      binance.rest.openOrders(scope, [
        regularOrderRow(binanceRawSamples.restPartiallyFilledOpenOrder),
      ]),
    ],
    expect: {
      openOrders: [
        {
          kind: 'regular',
          symbol: 'BRUSDT',
          exchangeOrderId: '999139867',
          customOrderId: 'x-15PC4ZJyPFmom0ss0n',
          status: 'partially_filled',
          quantity: '1394',
          executedQuantity: '697',
          averagePrice: '0.1607400',
          exchangePositionSide: 'LONG',
          strategySide: 'LONG',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-private-ws-partial-fill-updates-order-and-fill',
    description:
      'ORDER_TRADE_UPDATE PARTIALLY_FILLED updates the open order and records the fill.',
    facts: [
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(binanceRawSamples.userDataOrderPartiallyFilled),
      ),
    ],
    expect: {
      openOrders: [
        {
          kind: 'regular',
          symbol: 'BRUSDT',
          exchangeOrderId: '999139867',
          customOrderId: 'x-15PC4ZJyPFmom0ss0n',
          status: 'partially_filled',
          quantity: '1394',
          executedQuantity: '47',
          exchangePositionSide: 'LONG',
          strategySide: 'LONG',
        },
      ],
      fills: [
        {
          exchangeTradeId: '88874931',
          exchangeOrderId: '999139867',
          customOrderId: 'x-15PC4ZJyPFmom0ss0n',
          quantity: '47',
          price: '0.16074',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-zero-position-keeps-open-orders',
    description:
      'A zero-position account update closes the position without deleting still-open orders.',
    initialFacts: [
      binance.rest.positions(scope, [
        positionRow(binanceRawSamples.restOneWayLongPosition),
      ]),
      binance.rest.openOrders(scope, [
        regularOrderRow(binanceRawSamples.restOneWayRegularOpenOrder),
      ]),
      binance.rest.openAlgoOrders(scope, [
        algoOrderRow(binanceRawSamples.restOneWayClosePositionStopAlgo),
      ]),
    ],
    facts: [
      ...binance.ws.privateEvent(
        scope,
        accountUpdateEvent(binanceRawSamples.userDataAccountUpdateZeroPosition),
      ),
    ],
    expect: {
      positions: [] as [],
      openOrders: [
        {
          kind: 'regular',
          customOrderId: 'x-15PC4ZJyPM-U-L-B-D-01-L1-0',
        },
        {
          kind: 'algo',
          customTriggerOrderId: 'x-15PC4ZJyPM-U-L-B-X-01-L1-0',
          closePosition: true,
        },
      ],
      balances: [{ asset: 'BNFCR', walletBalance: '466.78328693' }],
    },
  },
  {
    name: 'binance-usdm-order-filled-removes-open-order-and-adds-fill',
    description:
      'ORDER_TRADE_UPDATE FILLED terminally removes the open order and records the fill.',
    initialFacts: [
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(binanceRawSamples.userDataOrderNew),
      ),
    ],
    facts: [
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(binanceRawSamples.userDataOrderFilled),
      ),
    ],
    expect: {
      openOrders: [] as [],
      fills: [
        {
          exchangeTradeId: '7617670499',
          exchangeOrderId: '1000254156391',
          customOrderId: 'web_usdt_vsharuft57kb0tle5qv1p1s',
          quantity: '0.006',
          price: '76430.3',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-algo-expired-removes-close-position-stop',
    description:
      'ALGO_UPDATE EXPIRED terminally removes a close-position stop-loss order.',
    initialFacts: [
      binance.rest.openAlgoOrders(scope, [
        algoOrderRow(binanceRawSamples.restOneWayClosePositionStopAlgo),
      ]),
    ],
    facts: [
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoExpired),
      ),
    ],
    expect: {
      openOrders: [] as [],
    },
  },
  {
    name: 'binance-usdm-algo-triggered-leaves-regular-order-active',
    description:
      'Triggered Algo evidence removes only the Algo row and leaves the generated regular order.',
    initialFacts: [
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoTriggerNew),
      ),
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoTriggering),
      ),
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(binanceRawSamples.userDataAlgoTriggeredOrderNew),
      ),
    ],
    facts: [
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoTriggered),
      ),
    ],
    expect: {
      openOrders: [
        {
          kind: 'regular',
          symbol: 'BRUSDT',
          exchangeOrderId: '1000517687',
          customOrderId: 'x-15PC4ZJyATmom1v3ns',
          type: 'MARKET',
          status: 'new',
          exchangePositionSide: 'SHORT',
          strategySide: 'SHORT',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-algo-finished-removes-algo-and-records-regular-fill',
    description:
      'FINISHED Algo evidence removes the Algo row while ORDER_TRADE_UPDATE records the actual fill.',
    initialFacts: [
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoTriggerNew),
      ),
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoTriggering),
      ),
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(binanceRawSamples.userDataAlgoTriggeredOrderNew),
      ),
    ],
    facts: [
      ...binance.ws.privateEvent(
        scope,
        orderTradeUpdateEvent(
          binanceRawSamples.userDataAlgoTriggeredOrderFilled,
        ),
      ),
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(binanceRawSamples.userDataAlgoFinished),
      ),
    ],
    expect: {
      openOrders: [] as [],
      fills: [
        {
          exchangeTradeId: '88940130',
          exchangeOrderId: '1000517687',
          customOrderId: 'x-15PC4ZJyATmom1v3ns',
          quantity: '153',
          price: '0.16312',
        },
      ],
    },
  },
  {
    name: 'binance-usdm-close-position-quantity-canonicalizes-to-zero',
    description:
      'Binance accepts closePosition plus quantity when a matching position exists and echoes quantity zero.',
    facts: [
      ...binance.ws.privateEvent(
        scope,
        algoUpdateEvent(
          binanceRawSamples.userDataClosePositionQuantityCanonicalizedAlgoNew,
        ),
      ),
    ],
    expect: {
      openOrders: [
        {
          kind: 'algo',
          symbol: 'BRUSDT',
          customTriggerOrderId: 'x-15PC4ZJyCPQmom2a88xERR',
          exchangeTriggerOrderId: '3000001400359919',
          quantity: '0',
          triggerPrice: '0.08585',
          closePosition: true,
          reduceOnly: true,
          timeInForce: 'GTE_GTC',
        },
      ],
    },
  },
] satisfies AccountStateFixture[];

function positionRow(row: unknown): BinanceUsdmPositionRow {
  return row as BinanceUsdmPositionRow;
}

function regularOrderRow(row: unknown): BinanceUsdmRegularOpenOrderRow {
  return row as BinanceUsdmRegularOpenOrderRow;
}

function algoOrderRow(row: unknown): BinanceUsdmOpenAlgoOrderRow {
  return row as BinanceUsdmOpenAlgoOrderRow;
}

function accountUpdateEvent(row: unknown): BinanceUsdmAccountUpdateEvent {
  return row as BinanceUsdmAccountUpdateEvent;
}

function orderTradeUpdateEvent(row: unknown): BinanceUsdmOrderTradeUpdateEvent {
  return row as BinanceUsdmOrderTradeUpdateEvent;
}

function algoUpdateEvent(row: unknown): BinanceUsdmAlgoUpdateEvent {
  return row as BinanceUsdmAlgoUpdateEvent;
}

export type BinanceFixturePositionExpectation = Partial<NormalizedPosition>;
export type BinanceFixtureOrderExpectation = Partial<NormalizedOrder>;

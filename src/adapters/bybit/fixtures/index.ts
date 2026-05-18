import type { AccountStateFixture } from '../../../fixtures/types.js';
import type {
  AccountScope,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../core/types.js';
import { bybit } from '../normalize.js';
import type {
  BybitV5LinearOrderRow,
  BybitV5LinearPositionRow,
  BybitV5PrivateEvent,
  BybitV5WalletBalanceRow,
} from '../types.js';
import { bybitRawSamples } from './raw.js';

export { bybitRawSamples } from './raw.js';

const scope: AccountScope = {
  exchange: 'bybit',
  accountId: 'sample',
  product: 'linear',
  environment: 'demo',
};

/**
 * Sample-backed Bybit V5 linear fixtures built from sanitized captured payloads.
 */
export const bybitAccountStateFixtures = [
  {
    name: 'bybit-v5-linear-rest-hedge-snapshot',
    description:
      'REST snapshots map hedge LONG/SHORT positions and active regular/conditional orders.',
    facts: [
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restHedgeLongPosition),
        positionRow(bybitRawSamples.restHedgeShortPosition),
      ]),
      bybit.rest.activeOrders(scope, [
        orderRow(bybitRawSamples.restNormalOpenLimitOrder),
        orderRow(bybitRawSamples.restReduceOnlyCloseOrder),
        orderRow(bybitRawSamples.restConditionalStopOrder),
      ]),
      bybit.rest.walletBalances(scope, [
        walletRow(bybitRawSamples.restWalletBalance),
      ]),
    ],
    expect: {
      positions: [
        {
          symbol: 'IPUSDT',
          exchangePositionSide: 'LONG',
          strategySide: 'LONG',
          quantity: '24.2',
          signedQuantity: '24.2',
        },
        {
          symbol: 'IPUSDT',
          exchangePositionSide: 'SHORT',
          strategySide: 'SHORT',
          quantity: '24.2',
          signedQuantity: '-24.2',
        },
      ],
      openOrders: [
        {
          kind: 'regular',
          exchangeOrderId: '28e130c6-195e-4b13-9b53-c90a0427dcf4',
          customOrderId: 'as-omzvga6-2-normal',
          status: 'new',
          quantity: '24.2',
        },
        {
          kind: 'regular',
          customOrderId: 'as-omzvgf0-3-roclose',
          reduceOnly: true,
          closePosition: false,
        },
        {
          kind: 'conditional',
          customOrderId: 'as-omzvgju-4-stop',
          triggerPrice: '0.4698',
          reduceOnly: true,
          closePosition: true,
          workingType: 'MarkPrice',
        },
      ],
      balances: [
        {
          asset: 'USDT',
          walletBalance: '1000',
          availableBalance: '900',
          lockedBalance: '10',
        },
      ],
      confidence: {
        positions: 'synced',
        openOrders: 'synced',
        balances: 'synced',
      },
    },
  },
  {
    name: 'bybit-v5-linear-rest-one-way-short',
    description:
      'REST snapshots map one-way positionIdx=0 plus Sell side to strategy SHORT.',
    facts: [
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restOneWayShortPosition),
      ]),
    ],
    expect: {
      positions: [
        {
          symbol: 'IPUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'SHORT',
          quantity: '24.2',
          signedQuantity: '-24.2',
        },
      ],
    },
  },
  {
    name: 'bybit-v5-linear-empty-rest-position-closes-existing-row',
    description:
      'Bybit REST returns an empty list after close, so replace-scope closes the existing position.',
    initialFacts: [
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restOneWayLongPosition),
      ]),
    ],
    facts: [bybit.rest.positions(scope, [])],
    expect: {
      positions: [] as [],
    },
  },
  {
    name: 'bybit-v5-linear-rest-zero-position-closes-only-that-symbol',
    description:
      'Bybit symbol-scoped REST can return zero-size rows, so the adapter closes that symbol without clearing unrelated positions.',
    initialFacts: [
      bybit.rest.positions(scope, [
        otherSymbolPositionRow('BTCUSDT'),
        positionRow(bybitRawSamples.restOneWayLongPosition),
      ]),
    ],
    facts: [
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restOneWayFlatPosition),
      ]),
    ],
    expect: {
      positions: [
        {
          symbol: 'BTCUSDT',
          exchangePositionSide: 'BOTH',
          strategySide: 'LONG',
          quantity: '24.2',
        },
      ],
      changeSets: [
        {
          itemsRemoved: 1,
        },
      ],
    },
  },
  {
    name: 'bybit-v5-linear-ws-zero-position-closes-existing-row',
    description:
      'Private position topic zero-size rows remove the matching normalized position.',
    initialFacts: [
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restOneWayLongPosition),
      ]),
    ],
    facts: [
      ...bybit.ws.privateEvent(
        scope,
        privateEvent(bybitRawSamples.wsZeroPositionEvent),
      ),
    ],
    expect: {
      positions: [] as [],
    },
  },
  {
    name: 'bybit-v5-linear-ws-order-filled-and-execution',
    description:
      'Private execution records the fill while terminal order status removes the open order.',
    initialFacts: [
      bybit.rest.activeOrders(scope, [filledOrderAsOpenOrder()]),
    ],
    facts: [
      ...bybit.ws.privateEvent(
        scope,
        privateEvent(bybitRawSamples.wsExecutionEvent),
      ),
      ...bybit.ws.privateEvent(
        scope,
        privateEvent(bybitRawSamples.wsFilledOrderEvent),
      ),
    ],
    expect: {
      openOrders: [] as [],
      fills: [
        {
          exchangeTradeId: 'ced0cb26-2bc8-4371-aa23-c601d1f5e41c',
          exchangeOrderId: '9bb63134-6f73-4fb2-beee-56c089952da2',
          customOrderId: 'as-omzvem5-1-ow-long',
          quantity: '24.2',
          price: '0.4945',
          fee: '0.0065818',
          feeAsset: 'USDT',
        },
      ],
    },
  },
] satisfies AccountStateFixture[];

function positionRow(row: unknown): BybitV5LinearPositionRow {
  return row as BybitV5LinearPositionRow;
}

function otherSymbolPositionRow(symbol: string): BybitV5LinearPositionRow {
  return positionRow({
    ...bybitRawSamples.restOneWayLongPosition,
    symbol,
  });
}

function orderRow(row: unknown): BybitV5LinearOrderRow {
  return row as BybitV5LinearOrderRow;
}

function walletRow(row: unknown): BybitV5WalletBalanceRow {
  return row as BybitV5WalletBalanceRow;
}

function privateEvent(row: unknown): BybitV5PrivateEvent {
  return row as BybitV5PrivateEvent;
}

function filledOrderAsOpenOrder(): BybitV5LinearOrderRow {
  const event = privateEvent(bybitRawSamples.wsFilledOrderEvent);
  const row = event.data[0] as unknown as Record<string, unknown>;
  return orderRow({
    ...row,
    orderStatus: 'New',
    leavesQty: row['qty'],
    cumExecQty: '0',
    cumExecFee: '0',
    cumExecValue: '0',
  });
}

export type BybitFixturePositionExpectation = Partial<NormalizedPosition>;
export type BybitFixtureOrderExpectation = Partial<NormalizedOrder>;

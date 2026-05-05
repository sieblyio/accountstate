import { ExchangeAccountStateStore } from '../../../src/core/ExchangeAccountStateStore';
import {
  bybit,
  bybitAccountStateFixtures,
  bybitRawSamples,
  classifyBybitSubmissionError,
  getBybitPositionIdx,
  isBybitAmendNoopError,
  isBybitDuplicateOrderIdError,
  isBybitUnknownOrderError,
  normalizeBybitV5LinearOrder,
  normalizeBybitV5LinearPosition,
  normalizeBybitV5PrivateEvent,
  summarizeBybitV5PrivateEvent,
} from '../../../src/adapters/bybit';
import { runAccountStateFixtures } from '../../../src/conformance';
import type { AccountScope } from '../../../src/core';
import type {
  BybitV5LinearOrderRow,
  BybitV5LinearPositionRow,
  BybitV5PrivateEvent,
} from '../../../src/adapters/bybit';

const scope: AccountScope = {
  exchange: 'bybit',
  accountId: 'primary',
  product: 'linear',
  environment: 'demo',
};

describe('Bybit adapter normalizers', () => {
  it('passes the sample-backed Bybit fixture pack', () => {
    const results = runAccountStateFixtures({
      fixtures: bybitAccountStateFixtures,
    });

    expect(
      results.map((result) => ({
        name: result.fixture.name,
        passed: result.passed,
        failures: result.failures,
      })),
    ).toEqual(
      bybitAccountStateFixtures.map((fixture) => ({
        name: fixture.name,
        passed: true,
        failures: [] as [],
      })),
    );
  });

  it('normalizes one-way positions from side plus positionIdx=0', () => {
    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restOneWayLongPosition),
        scope,
      ),
    ).toMatchObject({
      symbol: 'IPUSDT',
      exchangePositionSide: 'BOTH',
      strategySide: 'LONG',
      quantity: '24.2',
      signedQuantity: '24.2',
    });

    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restOneWayShortPosition),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'BOTH',
      strategySide: 'SHORT',
      quantity: '24.2',
      signedQuantity: '-24.2',
    });
  });

  it('normalizes hedge positionIdx values directly', () => {
    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restHedgeLongPosition),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'LONG',
      strategySide: 'LONG',
      signedQuantity: '24.2',
    });

    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restHedgeShortPosition),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'SHORT',
      strategySide: 'SHORT',
      signedQuantity: '-24.2',
    });
  });

  it('returns the Bybit request positionIdx from raw or normalized rows', () => {
    const hedgeLong = normalizeBybitV5LinearPosition(
      positionRow(bybitRawSamples.restHedgeLongPosition),
      scope,
    );
    const hedgeShortOrder = normalizeBybitV5LinearOrder(
      orderRow({
        ...bybitRawSamples.restConditionalStopOrder,
        positionIdx: 2,
      }),
      scope,
    );

    expect(getBybitPositionIdx(hedgeLong)).toBe(1);
    expect(getBybitPositionIdx(hedgeShortOrder)).toBe(2);
    expect(getBybitPositionIdx({ exchangePositionSide: 'BOTH' })).toBe(0);
    expect(getBybitPositionIdx({ raw: { positionIdx: '1' } })).toBe(1);
    expect(
      getBybitPositionIdx({ metadata: { exchangePositionSide: 'SHORT' } }),
    ).toBe(2);
  });

  it('normalizes REST zero-size positions as terminal flat rows', () => {
    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restOneWayFlatPosition),
        scope,
      ),
    ).toMatchObject({
      symbol: 'IPUSDT',
      exchangePositionSide: 'BOTH',
      strategySide: 'FLAT',
      quantity: '0',
      signedQuantity: '0',
    });

    expect(
      normalizeBybitV5LinearPosition(
        positionRow(bybitRawSamples.restHedgeFlatLongPosition),
        scope,
      ),
    ).toMatchObject({
      exchangePositionSide: 'LONG',
      strategySide: 'FLAT',
      quantity: '0',
    });
  });

  it('limits symbol-scoped REST flat rows to that symbol', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      bybit.rest.positions(scope, [
        positionRow({
          ...bybitRawSamples.restOneWayLongPosition,
          symbol: 'BTCUSDT',
        }),
        positionRow(bybitRawSamples.restOneWayLongPosition),
      ]),
    );

    const fact = bybit.rest.positions(scope, [
      positionRow(bybitRawSamples.restOneWayFlatPosition),
    ]);
    state.ingest(fact);

    expect(fact).toMatchObject({
      mode: 'replace-symbols',
      coverage: {
        symbols: ['IPUSDT'],
      },
      rows: [
        expect.objectContaining({
          symbol: 'IPUSDT',
          strategySide: 'FLAT',
          quantity: '0',
        }),
      ],
    });
    expect(state.getPositions(scope)).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        strategySide: 'LONG',
      }),
    ]);
  });

  it('maps Bybit orderId and orderLinkId to common order identities', () => {
    expect(
      normalizeBybitV5LinearOrder(
        orderRow(bybitRawSamples.restNormalOpenLimitOrder),
        scope,
      ),
    ).toMatchObject({
      kind: 'regular',
      exchangeOrderId: '28e130c6-195e-4b13-9b53-c90a0427dcf4',
      customOrderId: 'as-omzvga6-2-normal',
      status: 'new',
      side: 'BUY',
    });

    expect(
      normalizeBybitV5LinearOrder(
        orderRow(bybitRawSamples.restConditionalStopOrder),
        scope,
      ),
    ).toMatchObject({
      kind: 'conditional',
      customOrderId: 'as-omzvgju-4-stop',
      triggerPrice: '0.4698',
      reduceOnly: true,
      closePosition: true,
      workingType: 'MarkPrice',
    });
  });

  it('returns store-ingestable REST and WS facts through the namespaced helper', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      bybit.rest.positions(scope, [
        positionRow(bybitRawSamples.restOneWayLongPosition),
      ]),
    );
    state.ingest(
      bybit.rest.activeOrders(scope, [
        orderRow(bybitRawSamples.restNormalOpenLimitOrder),
      ]),
    );
    state.ingest(
      bybit.ws.privateEvent(
        scope,
        privateEvent(bybitRawSamples.wsZeroPositionEvent),
      ),
    );

    expect(state.getPositions(scope)).toEqual([]);
    expect(state.getOpenOrders(scope)).toEqual([
      expect.objectContaining({
        customOrderId: 'as-omzvga6-2-normal',
      }),
    ]);
  });

  it('normalizes private execution events into fills', () => {
    const facts = normalizeBybitV5PrivateEvent(
      privateEvent(bybitRawSamples.wsExecutionEvent),
      scope,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        type: 'trade_executed',
        fill: expect.objectContaining({
          exchangeTradeId: 'ced0cb26-2bc8-4371-aa23-c601d1f5e41c',
          exchangeOrderId: '9bb63134-6f73-4fb2-beee-56c089952da2',
          customOrderId: 'as-omzvem5-1-ow-long',
          quantity: '24.2',
          price: '0.4945',
          feeAsset: 'USDT',
        }),
      }),
    ]);
  });

  it('summarizes private events without applying store changes', () => {
    const event = privateEvent(bybitRawSamples.wsExecutionEvent);

    expect(summarizeBybitV5PrivateEvent(event)).toMatchObject({
      topic: 'execution',
      subjects: ['fills'],
      symbols: ['IPUSDT'],
      exchangeOrderIds: ['9bb63134-6f73-4fb2-beee-56c089952da2'],
      customOrderIds: ['as-omzvem5-1-ow-long'],
      executionTypes: ['Trade'],
    });
    expect(bybit.ws.summarizePrivateEvent(event)).toEqual(
      summarizeBybitV5PrivateEvent(event),
    );
  });

  it('normalizes terminal private order events into terminal evidence', () => {
    const facts = normalizeBybitV5PrivateEvent(
      privateEvent(bybitRawSamples.wsFilledOrderEvent),
      scope,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        type: 'terminal_evidence',
        identity: {
          exchangeOrderId: '9bb63134-6f73-4fb2-beee-56c089952da2',
          customOrderId: 'as-omzvem5-1-ow-long',
        },
        reason: 'filled',
      }),
    ]);
  });

  it('classifies Bybit REST error payloads', () => {
    expect(isBybitUnknownOrderError(bybitRawSamples.unknownOrderCancelError)).toBe(
      true,
    );
    expect(
      isBybitDuplicateOrderIdError(bybitRawSamples.duplicateOrderLinkIdError),
    ).toBe(true);
    expect(
      isBybitAmendNoopError({
        retCode: 10001,
        retMsg: 'order not modified',
      }),
    ).toBe(true);
    expect(
      isBybitAmendNoopError({
        retCode: 10001,
        retMsg: 'param invalid',
      }),
    ).toBe(false);
    expect(
      classifyBybitSubmissionError(bybitRawSamples.duplicateOrderLinkIdError),
    ).toEqual({
      message: 'OrderLinkedID is duplicate',
      code: 110072,
      retryable: false,
      raw: bybitRawSamples.duplicateOrderLinkIdError,
    });
    expect(classifyBybitSubmissionError(bybitRawSamples.invalidAuthError)).toEqual(
      {
        message: 'API key is invalid.',
        code: 401,
        retryable: false,
        raw: bybitRawSamples.invalidAuthError,
      },
    );
  });
});

function positionRow(row: unknown): BybitV5LinearPositionRow {
  return row as BybitV5LinearPositionRow;
}

function orderRow(row: unknown): BybitV5LinearOrderRow {
  return row as BybitV5LinearOrderRow;
}

function privateEvent(row: unknown): BybitV5PrivateEvent {
  return row as BybitV5PrivateEvent;
}

import { ExchangeAccountStateStore } from '../../../src';
import { binance } from '../../../src/adapters/binance';
import type { AccountScope, NormalizedOrder } from '../../../src';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

describe('Binance submission outcome helpers', () => {
  it('turns an accepted place response into a provisional order fact', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      binance.submission.placeAccepted({
        scope,
        intentId: 'place-1',
        customOrderId: 'client-1',
        order: order({ customOrderId: undefined }),
        acceptedAtMs: 1_700_000_000_000,
      }),
    );

    expect(state.getOpenOrders(scope)).toEqual([
      order({
        customOrderId: 'client-1',
        status: 'provisional',
        source: 'local',
        acceptedAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      }),
    ]);
  });

  it('turns a rejected place response into a rejected submission fact', () => {
    const state = new ExchangeAccountStateStore();
    state.recordOrderAccepted({
      scope,
      intentId: 'place-1',
      customOrderId: 'client-1',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.ingest(
      binance.submission.placeRejected({
        scope,
        intentId: 'place-1',
        customOrderId: 'client-1',
        error: { code: -2021, msg: 'Order would immediately trigger.' },
        rejectedAtMs: 2,
      }),
    );

    expect(changeSet).toMatchObject({
      itemsRemoved: 1,
      confidenceChanged: true,
    });
    expect(changeSet.warnings[0]).toMatchObject({
      name: 'local_submission_rejected',
      context: {
        error: {
          code: -2021,
          message: 'Order would immediately trigger.',
        },
      },
    });
    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns an accepted cancel response into terminal evidence', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [
      order({
        kind: 'algo',
        customOrderId: undefined,
        customTriggerOrderId: 'algo-client-1',
      }),
    ]);

    state.ingest(
      binance.submission.cancelAccepted({
        scope,
        identity: { customTriggerOrderId: 'algo-client-1' },
        cancelledAtMs: 2,
      }),
    );

    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns Binance unknown-order cancel rejection into absent-order evidence', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [
      order({
        kind: 'algo',
        customOrderId: undefined,
        customTriggerOrderId: 'algo-client-1',
      }),
    ]);

    const fact = binance.submission.cancelRejected({
      scope,
      identity: { customTriggerOrderId: 'algo-client-1' },
      error: { code: -2011, msg: 'Unknown order sent.' },
      atMs: 2,
    });

    expect(fact).toMatchObject({
      type: 'terminal_evidence',
      identity: { customTriggerOrderId: 'algo-client-1' },
      reason: 'order_not_found',
    });

    state.ingest(fact);

    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns other cancel rejections into status-unknown state checks', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [order({ customOrderId: 'client-1' })]);

    const changeSet = state.ingest(
      binance.submission.cancelRejected({
        scope,
        intentId: 'cancel-1',
        identity: { customOrderId: 'client-1' },
        error: { code: -1001, msg: 'Disconnected.' },
        atMs: 2,
      }),
    );

    expect(changeSet).toMatchObject({
      itemsRemoved: 0,
      confidenceChanged: true,
    });
    expect(state.getOpenOrders(scope)).toHaveLength(1);
    expect(state.getStateChecks(scope)).toEqual(
      expect.arrayContaining([
        {
          scope,
          subject: 'openOrders',
          reason: 'submission_unknown',
          priority: 'immediate',
          detectedAtMs: 2,
        },
      ]),
    );
  });
});

function order(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    ...scope,
    symbol: 'BTCUSDT',
    kind: 'regular',
    customOrderId: 'client-1',
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

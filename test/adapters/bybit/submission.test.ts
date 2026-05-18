import { ExchangeAccountStateStore } from '../../../src';
import { bybit, bybitRawSamples } from '../../../src/adapters/bybit';
import type { AccountScope, NormalizedOrder } from '../../../src';

const scope: AccountScope = {
  exchange: 'bybit',
  accountId: 'primary',
  product: 'linear',
  environment: 'demo',
};

describe('Bybit submission outcome helpers', () => {
  it('turns an accepted place response into a provisional order fact', () => {
    const state = new ExchangeAccountStateStore();

    state.ingest(
      bybit.submission.placeAccepted({
        scope,
        intentId: 'place-1',
        customOrderId: 'link-1',
        order: order({ customOrderId: undefined }),
        acceptedAtMs: 1_700_000_000_000,
      }),
    );

    expect(state.getOpenOrders(scope)).toEqual([]);
    expect(state.getOpenOrders(scope, { trust: 'includeProvisional' })).toEqual([
      order({
        customOrderId: 'link-1',
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
      customOrderId: 'link-1',
      order: order(),
      acceptedAtMs: 1,
    });

    const changeSet = state.ingest(
      bybit.submission.placeRejected({
        scope,
        intentId: 'place-1',
        customOrderId: 'link-1',
        error: bybitRawSamples.duplicateOrderLinkIdError,
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
          code: 110072,
          message: 'OrderLinkedID is duplicate',
        },
      },
    });
    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns an accepted cancel response into terminal evidence', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [order({ customOrderId: 'link-1' })]);

    state.ingest(
      bybit.submission.cancelAccepted({
        scope,
        identity: { customOrderId: 'link-1' },
        cancelledAtMs: 2,
      }),
    );

    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns Bybit unknown-order cancel rejection into absent-order evidence', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [order({ customOrderId: 'link-1' })]);

    const fact = bybit.submission.cancelRejected({
      scope,
      identity: { customOrderId: 'link-1' },
      error: bybitRawSamples.unknownOrderCancelError,
      atMs: 2,
    });

    expect(fact).toMatchObject({
      type: 'terminal_evidence',
      identity: { customOrderId: 'link-1' },
      reason: 'order_not_found',
    });

    state.ingest(fact);

    expect(state.getOpenOrders(scope)).toEqual([]);
  });

  it('turns other cancel rejections into status-unknown state checks', () => {
    const state = new ExchangeAccountStateStore();
    state.setOpenOrders(scope, [order({ customOrderId: 'link-1' })]);

    const changeSet = state.ingest(
      bybit.submission.cancelRejected({
        scope,
        intentId: 'cancel-1',
        identity: { customOrderId: 'link-1' },
        error: { retCode: 10016, retMsg: 'Server error.' },
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
    symbol: 'IPUSDT',
    kind: 'regular',
    customOrderId: 'link-1',
    side: 'BUY',
    type: 'Limit',
    status: 'new',
    exchangePositionSide: 'BOTH',
    strategySide: 'LONG',
    quantity: '24.2',
    price: '0.4945',
    owner: 'app',
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

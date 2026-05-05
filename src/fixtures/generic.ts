import type { AccountFact } from '../core/facts.js';
import type {
  AccountScope,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  SnapshotSubject,
} from '../core/types.js';
import type { AccountStateFixture } from './types.js';

const scope: AccountScope = {
  exchange: 'generic',
  accountId: 'primary',
  product: 'perp',
  environment: 'test',
};

export const defaultAccountStateFixtures = [
  {
    name: 'rest-position-replacement-closes-missing-position',
    description:
      'A REST position snapshot with no row for an existing position closes it.',
    initialFacts: [restSnapshot('positions', [position()], 1, 'replace-scope')],
    facts: [restSnapshot('positions', [], 2, 'replace-scope')],
    expect: {
      positions: [] as [],
      lifecycles: [] as [],
      confidence: {
        positions: 'synced',
      },
      stateChecks: [
        stateCheck('openOrders', 'startup', 'immediate'),
        stateCheck('balances', 'startup', 'immediate'),
        stateCheck('fills', 'startup', 'background'),
      ],
      changeSets: [
        {
          itemsRemoved: 1,
        },
      ],
    },
  },
  {
    name: 'rest-open-order-replacement-marks-absent-app-order-stale',
    description:
      'A scoped open-order REST snapshot removes absent manual orders but keeps absent app-owned orders visible as stale.',
    initialFacts: [
      restSnapshot('positions', [position()], 1, 'replace-scope'),
      restSnapshot(
        'openOrders',
        [
          order({
            exchangeOrderId: '1001',
            customOrderId: 'app-1001',
            owner: 'app',
          }),
          order({
            exchangeOrderId: '1002',
            customOrderId: 'manual-1002',
            owner: 'manual',
          }),
        ],
        1,
        'replace-scope',
      ),
      restSnapshot('balances', [balance()], 1, 'replace-scope'),
      restSnapshot('fills', [], 1, 'upsert-only'),
    ],
    facts: [restSnapshot('openOrders', [], 2, 'replace-scope')],
    expect: {
      openOrders: [
        {
          exchangeOrderId: '1001',
          customOrderId: 'app-1001',
          status: 'stale',
        },
      ],
      confidence: {
        openOrders: 'stale',
      },
      stateChecks: [stateCheck('openOrders', 'stale_state', 'immediate')],
      changeSets: [
        {
          itemsRemoved: 1,
          itemsMarkedStale: 1,
        },
      ],
    },
  },
  {
    name: 'accepted-submission-creates-provisional-order',
    description:
      'A successful order submission is retained as provisional local evidence before REST or stream confirmation arrives.',
    facts: [
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-1001',
        order: order({
          exchangeOrderId: undefined,
          customOrderId: undefined,
          source: 'local',
        }),
        acceptedAtMs: 1,
      },
    ],
    expect: {
      openOrders: [
        {
          customOrderId: 'client-1001',
          status: 'provisional',
          source: 'local',
          acceptedAtMs: 1,
          updatedAtMs: 1,
        },
      ],
      confidence: {
        openOrders: 'local_only',
      },
      stateChecks: [
        stateCheck('positions', 'startup', 'immediate'),
        stateCheck('balances', 'startup', 'immediate'),
        stateCheck('fills', 'startup', 'background'),
      ],
      changeSets: [
        {
          itemsAdded: 1,
          itemsUpdated: 0,
          warnings: [] as [],
        },
      ],
    },
  },
  {
    name: 'stream-confirmation-converts-provisional-to-open',
    description:
      'A private WebSocket order update converges a provisional custom-order-id order with the exchange order id.',
    initialFacts: [
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-1001',
        order: order({ exchangeOrderId: undefined, source: 'local' }),
        acceptedAtMs: 1,
      },
    ],
    facts: [
      {
        type: 'order_updated',
        scope,
        order: order({
          exchangeOrderId: '1001',
          customOrderId: 'client-1001',
          status: 'new',
          source: 'ws',
          updatedAtMs: 2,
        }),
        provenance: {
          source: 'ws',
          receivedAtMs: 2,
        },
      },
    ],
    expect: {
      openOrders: [
        {
          exchangeOrderId: '1001',
          customOrderId: 'client-1001',
          status: 'new',
          source: 'ws',
        },
      ],
      confidence: {
        openOrders: 'stream_only',
      },
      stateChecks: [
        stateCheck('positions', 'startup', 'immediate'),
        stateCheck('balances', 'startup', 'immediate'),
        stateCheck('fills', 'startup', 'background'),
      ],
      changeSets: [
        {
          itemsAdded: 0,
          itemsUpdated: 1,
        },
      ],
    },
  },
  {
    name: 'duplicate-custom-custom-order-id-detected',
    description:
      'A duplicate accepted custom order id updates the existing provisional row and reports a warning.',
    facts: [
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-1001',
        order: order({ exchangeOrderId: undefined, source: 'local' }),
        acceptedAtMs: 1,
      },
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-2',
        customOrderId: 'client-1001',
        order: order({ exchangeOrderId: undefined, source: 'local' }),
        acceptedAtMs: 2,
      },
    ],
    expect: {
      openOrders: [
        {
          customOrderId: 'client-1001',
          status: 'provisional',
          acceptedAtMs: 2,
        },
      ],
      changeSets: [
        {
          itemsAdded: 1,
        },
        {
          itemsAdded: 0,
          itemsUpdated: 1,
          warnings: [{ name: 'duplicate_active_custom_order_id' }],
        },
      ],
    },
  },
  {
    name: 'submission-rejection-adds-state-check',
    description:
      'A rejected submission removes the provisional row and requests an open-order REST refresh.',
    initialFacts: [
      {
        type: 'local_submission_accepted',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-1001',
        order: order({ exchangeOrderId: undefined, source: 'local' }),
        acceptedAtMs: 1,
      },
    ],
    facts: [
      {
        type: 'local_submission_rejected',
        scope,
        intentId: 'intent-1',
        customOrderId: 'client-1001',
        error: {
          message: 'Duplicate custom order id',
          code: -4116,
        },
        rejectedAtMs: 2,
      },
    ],
    expect: {
      openOrders: [] as [],
      confidence: {
        openOrders: 'stale',
      },
      stateChecks: [
        stateCheck('openOrders', 'conflicting_state', 'soon', 2),
        stateCheck('positions', 'startup', 'immediate'),
        stateCheck('balances', 'startup', 'immediate'),
        stateCheck('fills', 'startup', 'background'),
      ],
      changeSets: [
        {
          itemsRemoved: 1,
          warnings: [{ name: 'local_submission_rejected' }],
        },
      ],
    },
  },
  {
    name: 'stream-gap-adds-state-check',
    description:
      'A private WebSocket stream gap marks account subjects stale and requests immediate REST refresh.',
    initialFacts: [
      restSnapshot('positions', [position()], 1, 'replace-scope'),
      restSnapshot('openOrders', [order()], 1, 'replace-scope'),
      restSnapshot('balances', [balance()], 1, 'replace-scope'),
      restSnapshot('fills', [fill()], 1, 'upsert-only'),
    ],
    facts: [
      {
        type: 'stream_health',
        scope,
        status: 'gap',
        reason: 'missed sequence',
        atMs: 2,
      },
    ],
    expect: {
      confidence: {
        positions: 'stale',
        openOrders: 'stale',
        balances: 'stale',
        fills: 'stale',
        stream: 'stale',
      },
      stateChecks: [
        stateCheck('positions', 'stream_gap', 'immediate', 2),
        stateCheck('openOrders', 'stream_gap', 'immediate', 2),
        stateCheck('balances', 'stream_gap', 'immediate', 2),
        stateCheck('fills', 'stream_gap', 'immediate', 2),
      ],
      changeSets: [
        {
          warnings: [{ name: 'stream_gap' }],
        },
      ],
    },
  },
  {
    name: 'full-close-cleanup-pending-until-orders-terminal',
    description:
      'A closed position remains in cleanup until app-owned open orders are proven terminal.',
    initialFacts: [
      restSnapshot('positions', [position()], 1, 'replace-scope'),
      restSnapshot('openOrders', [order()], 1, 'replace-scope'),
      restSnapshot('balances', [balance()], 1, 'replace-scope'),
      restSnapshot('fills', [], 1, 'upsert-only'),
    ],
    facts: [
      restSnapshot('positions', [], 2, 'replace-scope'),
      {
        type: 'terminal_evidence',
        scope,
        identity: {
          customOrderId: 'client-1001',
        },
        reason: 'order_not_found',
        atMs: 3,
      },
    ],
    expect: {
      positions: [] as [],
      openOrders: [] as [],
      lifecycles: [] as [],
      stateChecks: [] as [],
      changeSets: [
        {
          itemsRemoved: 1,
        },
        {
          itemsRemoved: 1,
        },
      ],
    },
  },
] satisfies AccountStateFixture[];

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
    customOrderId: 'client-1001',
    side: 'BUY',
    price: '49000.00',
    quantity: '0.100',
    executedAtMs: 1,
    updatedAtMs: 1,
    source: 'rest',
    ...overrides,
  };
}

function restSnapshot<T>(
  subject: SnapshotSubject,
  rows: T[],
  asOfMs: number,
  mode: 'replace-scope' | 'replace-symbols' | 'upsert-only',
): AccountFact {
  return {
    type: 'rest_snapshot',
    scope,
    subject,
    mode,
    rows,
    source: 'rest',
    asOfMs,
  };
}

function stateCheck(
  subject: 'positions' | 'openOrders' | 'balances' | 'fills',
  reason: 'startup' | 'stream_gap' | 'conflicting_state' | 'stale_state',
  priority: 'immediate' | 'soon' | 'background',
  detectedAtMs?: number,
) {
  return {
    scope,
    subject,
    reason,
    priority,
    detectedAtMs,
  };
}

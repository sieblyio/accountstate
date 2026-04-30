import { ExchangeAccountStateStore } from '../../src';
import type { AccountScope, SnapshotSubject } from '../../src';

const scope: AccountScope = {
  exchange: 'binance',
  accountId: 'primary',
  product: 'usdm',
  environment: 'testnet',
};

const accountSubjects: Exclude<SnapshotSubject, 'filters'>[] = [
  'positions',
  'openOrders',
  'balances',
  'fills',
];

function hydrateAllSubjects(state: ExchangeAccountStateStore): void {
  for (const subject of accountSubjects) {
    state.applySnapshot({
      scope,
      subject,
      mode: 'replace-scope',
      rows: [],
      source: 'rest',
      asOfMs: 1,
    });
  }
}

describe('ExchangeAccountStateStore confidence and hydration', () => {
  it('returns startup hydration needs for unknown account subjects', () => {
    const state = new ExchangeAccountStateStore();

    expect(state.getAccountView(scope).confidence).toEqual({
      positions: 'unknown',
      openOrders: 'unknown',
      balances: 'unknown',
      fills: 'unknown',
    });
    expect(state.getHydrationNeeds(scope)).toEqual([
      {
        scope,
        subject: 'positions',
        reason: 'startup',
        priority: 'immediate',
      },
      {
        scope,
        subject: 'openOrders',
        reason: 'startup',
        priority: 'immediate',
      },
      {
        scope,
        subject: 'balances',
        reason: 'startup',
        priority: 'immediate',
      },
      {
        scope,
        subject: 'fills',
        reason: 'startup',
        priority: 'immediate',
      },
    ]);
  });

  it('REST hydration clears startup needs for the hydrated subject', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = state.applySnapshot({
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [],
      source: 'rest',
      asOfMs: 1,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      confidenceChanged: true,
    });
    expect(state.getAccountView(scope).confidence.positions).toBe(
      'rest_hydrated',
    );
    expect(state.getHydrationNeeds(scope)).toEqual([
      {
        scope,
        subject: 'openOrders',
        reason: 'startup',
        priority: 'immediate',
      },
      {
        scope,
        subject: 'balances',
        reason: 'startup',
        priority: 'immediate',
      },
      {
        scope,
        subject: 'fills',
        reason: 'startup',
        priority: 'immediate',
      },
    ]);
  });

  it('stream gaps mark account subjects stale and request hydration', () => {
    const state = new ExchangeAccountStateStore();
    hydrateAllSubjects(state);

    const changeSet = state.applyStreamHealthFact({
      type: 'stream_health',
      scope,
      status: 'gap',
      reason: 'sequence gap',
      atMs: 2,
      provenance: {
        source: 'ws',
        receivedAtMs: 2,
        eventId: 'gap-1',
        sequence: '42',
      },
    });

    expect(changeSet).toMatchObject({
      changed: true,
      confidenceChanged: true,
    });
    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'stream_gap',
    ]);
    expect(state.getAccountView(scope).confidence).toEqual({
      positions: 'stale',
      openOrders: 'stale',
      balances: 'stale',
      fills: 'stale',
      stream: 'stale',
    });
    expect(state.getAccountView(scope).watermarks.stream).toEqual({
      source: 'ws',
      asOfMs: 2,
      receivedAtMs: 2,
      eventId: 'gap-1',
      sequence: '42',
    });
    expect(state.getHydrationNeeds(scope)).toEqual(
      accountSubjects.map((subject) => ({
        scope,
        subject,
        reason: 'stream_gap',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });

  it('reconnects keep stream confidence connected but request account hydration', () => {
    const state = new ExchangeAccountStateStore();
    hydrateAllSubjects(state);

    const changeSet = state.applyStreamHealthFact({
      type: 'stream_health',
      scope,
      status: 'reconnected',
      reason: 'socket restarted',
      atMs: 2,
    });

    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'stream_reconnected',
    ]);
    expect(state.getAccountView(scope).confidence).toEqual({
      positions: 'stale',
      openOrders: 'stale',
      balances: 'stale',
      fills: 'stale',
      stream: 'stream_only',
    });
    expect(state.getHydrationNeeds(scope)).toEqual(
      accountSubjects.map((subject) => ({
        scope,
        subject,
        reason: 'stream_reconnected',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });

  it.each([
    ['disconnected', 'stream_disconnected', 'stream_gap'],
    ['expired', 'listen_key_expired', 'ttl_expired'],
  ] as const)(
    '%s stream health facts request immediate hydration',
    (status, warningName, hydrationReason) => {
      const state = new ExchangeAccountStateStore();
      hydrateAllSubjects(state);

      const changeSet = state.applyStreamHealthFact({
        type: 'stream_health',
        scope,
        status,
        atMs: 2,
      });

      expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
        warningName,
      ]);
      expect(state.getAccountView(scope).confidence.stream).toBe('stale');
      expect(state.getHydrationNeeds(scope)).toEqual(
        accountSubjects.map((subject) => ({
          scope,
          subject,
          reason: hydrationReason,
          priority: 'immediate',
          requestedAtMs: 2,
        })),
      );
    },
  );

  it('REST snapshots clear matching stream hydration needs', () => {
    const state = new ExchangeAccountStateStore();
    hydrateAllSubjects(state);
    state.applyStreamHealthFact({
      type: 'stream_health',
      scope,
      status: 'gap',
      atMs: 2,
    });

    state.applySnapshot({
      scope,
      subject: 'positions',
      mode: 'replace-scope',
      rows: [],
      source: 'rest',
      asOfMs: 3,
    });

    expect(state.getAccountView(scope).confidence.positions).toBe(
      'rest_hydrated',
    );
    expect(state.getHydrationNeeds(scope)).toEqual(
      ['openOrders', 'balances', 'fills'].map((subject) => ({
        scope,
        subject,
        reason: 'stream_gap',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });
});

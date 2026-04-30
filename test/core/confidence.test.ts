import { ExchangeAccountStateStore } from '../../src';
import type { AccountScope } from '../../src';
import type { SnapshotSubject } from '../../src/core';

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

function syncAllSubjects(state: ExchangeAccountStateStore): void {
  for (const subject of accountSubjects) {
    switch (subject) {
      case 'positions':
        state.syncPositions(scope, [], { mode: 'replace-scope', asOfMs: 1 });
        break;
      case 'openOrders':
        state.syncOpenOrders(scope, [], { mode: 'replace-scope', asOfMs: 1 });
        break;
      case 'balances':
        state.syncBalances(scope, [], { mode: 'replace-scope', asOfMs: 1 });
        break;
      case 'fills':
        state.syncFills(scope, [], { mode: 'replace-scope', asOfMs: 1 });
        break;
    }
  }
}

describe('ExchangeAccountStateStore confidence and sync', () => {
  it('returns startup sync requests for unknown account subjects', () => {
    const state = new ExchangeAccountStateStore();

    expect(state.getAccountView(scope).confidence).toEqual({
      positions: 'unknown',
      openOrders: 'unknown',
      balances: 'unknown',
      fills: 'unknown',
    });
    expect(state.getSyncRequests(scope)).toEqual([
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
        priority: 'background',
      },
    ]);
  });

  it('REST sync clears startup requests for the synced subject', () => {
    const state = new ExchangeAccountStateStore();

    const changeSet = state.syncPositions(scope, [], {
      mode: 'replace-scope',
      asOfMs: 1,
    });

    expect(changeSet).toMatchObject({
      changed: true,
      confidenceChanged: true,
    });
    expect(state.getAccountView(scope).confidence.positions).toBe('synced');
    expect(state.getSyncRequests(scope)).toEqual([
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
        priority: 'background',
      },
    ]);
  });

  it('stream gaps mark account subjects stale and request sync', () => {
    const state = new ExchangeAccountStateStore();
    syncAllSubjects(state);

    const changeSet = state.streamGap(scope, {
      reason: 'sequence gap',
      atMs: 2,
      receivedAtMs: 2,
      eventId: 'gap-1',
      sequence: '42',
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
    expect(state.getSyncRequests(scope)).toEqual(
      accountSubjects.map((subject) => ({
        scope,
        subject,
        reason: 'stream_gap',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });

  it('reconnects keep stream confidence connected but request account sync', () => {
    const state = new ExchangeAccountStateStore();
    syncAllSubjects(state);

    const changeSet = state.streamReconnected(scope, {
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
    expect(state.getSyncRequests(scope)).toEqual(
      accountSubjects.map((subject) => ({
        scope,
        subject,
        reason: 'stream_reconnected',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });

  it('disconnected stream health facts request immediate sync', () => {
    const state = new ExchangeAccountStateStore();
    syncAllSubjects(state);

    const changeSet = state.streamDisconnected(scope, { atMs: 2 });

    expect(changeSet.warnings.map((warning) => warning.name)).toEqual([
      'stream_disconnected',
    ]);
    expect(state.getAccountView(scope).confidence.stream).toBe('stale');
    expect(state.getSyncRequests(scope)).toEqual(
      accountSubjects.map((subject) => ({
        scope,
        subject,
        reason: 'stream_gap',
        priority: 'immediate',
        requestedAtMs: 2,
      })),
    );
  });

  it('REST snapshots clear matching stream sync requests', () => {
    const state = new ExchangeAccountStateStore();
    syncAllSubjects(state);
    state.streamGap(scope, { atMs: 2 });

    state.syncPositions(scope, [], { mode: 'replace-scope', asOfMs: 3 });

    expect(state.getAccountView(scope).confidence.positions).toBe('synced');
    expect(state.getSyncRequests(scope)).toEqual(
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

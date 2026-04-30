import type { StreamHealthFact } from './facts.js';
import type {
  AccountScope,
  AccountViewConfidence,
  ConfidenceState,
  SyncRequest,
  SyncReason,
  SyncSubject,
  NormalizedOrder,
  SnapshotInput,
  SnapshotSubject,
  StateSource,
  StateWarning,
  SubjectWatermark,
} from './types.js';
import { copyScope } from './utils.js';

const ACCOUNT_SYNC_SUBJECTS = [
  'positions',
  'openOrders',
  'balances',
  'fills',
] as const satisfies readonly SyncSubject[];

/**
 * New scopes start untrusted until the parent app supplies snapshots/events.
 */
export function createInitialConfidence(): AccountViewConfidence {
  return {
    positions: 'unknown',
    openOrders: 'unknown',
    balances: 'unknown',
    fills: 'unknown',
  };
}

/**
 * Convert snapshot metadata into the compact watermark exposed on account views.
 */
export function createWatermark(
  input: SnapshotInput<unknown>,
): SubjectWatermark {
  return watermarkFromProvenance(input.source, input.asOfMs, input.provenance);
}

/**
 * Convert stream-health metadata into the stream watermark slot.
 */
export function createStreamWatermark(
  input: StreamHealthFact,
): SubjectWatermark {
  return watermarkFromProvenance(
    input.provenance?.source ?? 'ws',
    input.atMs,
    input.provenance,
  );
}

/**
 * Map snapshot subjects onto the corresponding confidence slot.
 */
export function confidenceKeyForSubject(
  subject: SnapshotSubject,
): keyof AccountViewConfidence {
  switch (subject) {
    case 'positions':
      return 'positions';
    case 'openOrders':
      return 'openOrders';
    case 'balances':
      return 'balances';
    case 'fills':
      return 'fills';
    case 'filters':
      return 'filters';
  }
}

/**
 * Initial confidence derived from source type.
 */
export function confidenceFromSource(source: StateSource): ConfidenceState {
  switch (source) {
    case 'ws':
      return 'stream_only';
    case 'local':
    case 'manual':
      return 'local_only';
    case 'rest':
    case 'replay':
    case 'test':
      return 'synced';
  }
}

/**
 * Return true when a snapshot source should satisfy pending sync work.
 */
export function isSyncingSnapshotSource(source: StateSource): boolean {
  return source === 'rest' || source === 'replay' || source === 'test';
}

/**
 * Apply stream-health state to confidence without mutating the input object.
 */
export function confidenceFromStreamHealth(
  confidence: AccountViewConfidence,
  status: StreamHealthFact['status'],
): AccountViewConfidence {
  const next: AccountViewConfidence = { ...confidence };

  switch (status) {
    case 'connected':
      next.stream = 'stream_only';
      return next;
    case 'reconnected':
      next.stream = 'stream_only';
      return markAccountSubjectsStale(next);
    case 'disconnected':
    case 'gap':
      next.stream = 'stale';
      return markAccountSubjectsStale(next);
  }
}

/**
 * Convert stream-health facts that imply missed events into sync requests.
 */
export function getStreamHealthSyncRequests(
  input: StreamHealthFact,
): SyncRequest[] {
  const plan = getStreamHealthSyncPlan(input.status);
  if (!plan) {
    return [];
  }

  return ACCOUNT_SYNC_SUBJECTS.map((subject) => ({
    scope: copyScope(input.scope),
    subject,
    reason: plan.reason,
    priority: plan.priority,
    requestedAtMs: input.atMs,
  }));
}

/**
 * Return a warning for stream-health facts that should affect planning.
 */
export function getStreamHealthWarning(
  input: StreamHealthFact,
): StateWarning | undefined {
  switch (input.status) {
    case 'connected':
      return undefined;
    case 'reconnected':
      return createStreamWarning(
        input,
        'stream_reconnected',
        'Private stream reconnected; account state needs sync.',
      );
    case 'disconnected':
      return createStreamWarning(
        input,
        'stream_disconnected',
        'Private stream disconnected; account state needs sync.',
      );
    case 'gap':
      return createStreamWarning(
        input,
        'stream_gap',
        'Private stream reported a gap; account state needs sync.',
      );
  }
}

/**
 * Produce coarse sync reasons from confidence, stale rows, and explicit
 * scheduler requests.
 */
export function getSyncReasons(
  confidence: AccountViewConfidence,
  openOrders: NormalizedOrder[],
  syncRequests: SyncRequest[],
): string[] {
  const reasons: string[] = [];
  for (const subject of ACCOUNT_SYNC_SUBJECTS) {
    addConfidenceReason(reasons, subject, confidence[subject]);
  }
  if (confidence.filters) {
    addConfidenceReason(reasons, 'filters', confidence.filters);
  }
  if (confidence.stream) {
    addConfidenceReason(reasons, 'stream', confidence.stream);
  }

  if (openOrders.some((order) => order.status === 'stale')) {
    reasons.push('openOrders_stale');
  }
  for (const request of syncRequests) {
    reasons.push(`${request.subject}_${request.reason}`);
  }

  return Array.from(new Set(reasons));
}

/**
 * Combine explicit scheduler requests with fallback requests for subjects whose
 * confidence says a REST refresh can reasonably help.
 */
export function getSyncRequestsForConfidence(
  scope: AccountScope,
  confidence: AccountViewConfidence,
  explicitRequests: SyncRequest[],
): SyncRequest[] {
  const requests = explicitRequests.map(cloneSyncRequest);
  const subjectsWithExplicitRequests = new Set(
    requests.map((request) => request.subject),
  );

  for (const subject of ACCOUNT_SYNC_SUBJECTS) {
    if (subjectsWithExplicitRequests.has(subject)) {
      continue;
    }

    const confidenceState = confidence[subject];
    if (confidenceState === 'unknown') {
      requests.push(createFallbackSyncRequest(scope, subject, 'startup'));
    } else if (confidenceState === 'stale') {
      requests.push(createFallbackSyncRequest(scope, subject, 'stale_state'));
    } else if (confidenceState === 'conflicted') {
      requests.push(
        createFallbackSyncRequest(scope, subject, 'conflicting_state'),
      );
    }
  }

  return dedupeSyncRequests(requests);
}

/**
 * Stable key for a sync request within one account scope.
 */
export function getSyncRequestKey(request: SyncRequest): string {
  return `${request.subject}:${request.reason}`;
}

/**
 * Clone sync requests before exposing them to callers or internal maps.
 */
export function cloneSyncRequest(request: SyncRequest): SyncRequest {
  return {
    ...request,
    scope: copyScope(request.scope),
  };
}

/**
 * Compare confidence slots structurally without caring about object identity.
 */
export function isSameConfidence(
  a: AccountViewConfidence,
  b: AccountViewConfidence,
): boolean {
  return (
    a.positions === b.positions &&
    a.openOrders === b.openOrders &&
    a.balances === b.balances &&
    a.fills === b.fills &&
    a.filters === b.filters &&
    a.stream === b.stream
  );
}

/**
 * Compare watermarks by value so repeated identical inputs can be no-op change
 * sets when they also make no state changes.
 */
export function isSameWatermark(
  a: SubjectWatermark | undefined,
  b: SubjectWatermark | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function watermarkFromProvenance(
  source: StateSource,
  asOfMs: number,
  provenance: SnapshotInput<unknown>['provenance'],
): SubjectWatermark {
  const watermark: SubjectWatermark = {
    source,
    asOfMs,
  };

  if (provenance?.receivedAtMs !== undefined) {
    watermark.receivedAtMs = provenance.receivedAtMs;
  }
  if (provenance?.snapshotId !== undefined) {
    watermark.snapshotId = provenance.snapshotId;
  }
  if (provenance?.eventId !== undefined) {
    watermark.eventId = provenance.eventId;
  }
  if (provenance?.sequence !== undefined) {
    watermark.sequence = provenance.sequence;
  }

  return watermark;
}

function markAccountSubjectsStale(
  confidence: AccountViewConfidence,
): AccountViewConfidence {
  const next: AccountViewConfidence = { ...confidence };
  for (const subject of ACCOUNT_SYNC_SUBJECTS) {
    next[subject] = 'stale';
  }

  return next;
}

function getStreamHealthSyncPlan(status: StreamHealthFact['status']):
  | {
      reason: SyncReason;
      priority: SyncRequest['priority'];
    }
  | undefined {
  switch (status) {
    case 'connected':
      return undefined;
    case 'reconnected':
      return { reason: 'stream_reconnected', priority: 'immediate' };
    case 'disconnected':
    case 'gap':
      return { reason: 'stream_gap', priority: 'immediate' };
  }
}

function createFallbackSyncRequest(
  scope: AccountScope,
  subject: SyncSubject,
  reason: SyncReason,
): SyncRequest {
  return {
    scope: copyScope(scope),
    subject,
    reason,
    priority:
      subject === 'fills' && reason === 'startup' ? 'background' : 'immediate',
  };
}

function createStreamWarning(
  input: StreamHealthFact,
  name: string,
  message: string,
): StateWarning {
  return {
    name,
    scope: copyScope(input.scope),
    message,
    context: {
      status: input.status,
      reason: input.reason,
    },
  };
}

function addConfidenceReason(
  reasons: string[],
  subject: string,
  value: ConfidenceState,
): void {
  if (value === 'unknown') {
    reasons.push(`${subject}_unknown`);
  } else if (value === 'stale') {
    reasons.push(`${subject}_stale`);
  } else if (value === 'conflicted') {
    reasons.push(`${subject}_conflicted`);
  } else if (value === 'paused') {
    reasons.push(`${subject}_paused`);
  }
}

function dedupeSyncRequests(requests: SyncRequest[]): SyncRequest[] {
  const deduped = new Map<string, SyncRequest>();
  for (const request of requests) {
    deduped.set(getSyncRequestKey(request), cloneSyncRequest(request));
  }

  return Array.from(deduped.values());
}

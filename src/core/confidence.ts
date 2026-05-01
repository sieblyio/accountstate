import type { StreamHealthFact } from './facts.js';
import type {
  AccountScope,
  AccountViewConfidence,
  ConfidenceState,
  StateCheck,
  StateCheckReason,
  StateCheckSubject,
  NormalizedOrder,
  SnapshotInput,
  SnapshotSubject,
  StateSource,
  StateWarning,
  SubjectWatermark,
} from './types.js';
import { copyScope } from './utils.js';

const ACCOUNT_STATE_CHECK_SUBJECTS = [
  'positions',
  'openOrders',
  'balances',
  'fills',
] as const satisfies readonly StateCheckSubject[];

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
 * Return true when a snapshot source should satisfy pending state checks.
 */
export function isAuthoritativeSnapshotSource(source: StateSource): boolean {
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
 * Convert stream-health facts that may imply missed events into state checks.
 */
export function getStreamHealthStateChecks(
  input: StreamHealthFact,
): StateCheck[] {
  const plan = getStreamHealthStateCheckPlan(input.status);
  if (!plan) {
    return [];
  }

  return ACCOUNT_STATE_CHECK_SUBJECTS.map((subject) => ({
    scope: copyScope(input.scope),
    subject,
    reason: plan.reason,
    priority: plan.priority,
    detectedAtMs: input.atMs,
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
        'Private account-data stream reconnected; account state needs checking.',
      );
    case 'disconnected':
      return createStreamWarning(
        input,
        'stream_disconnected',
        'Private account-data stream disconnected; account state needs checking.',
      );
    case 'gap':
      return createStreamWarning(
        input,
        'stream_gap',
        'Private account-data stream reported a gap; account state needs checking.',
      );
  }
}

/**
 * Produce coarse state-check reasons from confidence, stale rows, and explicit
 * state checks.
 */
export function getStateCheckReasons(
  confidence: AccountViewConfidence,
  openOrders: NormalizedOrder[],
  stateChecks: StateCheck[],
): string[] {
  const reasons: string[] = [];
  for (const subject of ACCOUNT_STATE_CHECK_SUBJECTS) {
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
  for (const check of stateChecks) {
    reasons.push(`${check.subject}_${check.reason}`);
  }

  return Array.from(new Set(reasons));
}

/**
 * Combine explicit checks with fallback checks for subjects whose confidence
 * says a REST snapshot can reasonably help.
 */
export function getStateChecksForConfidence(
  scope: AccountScope,
  confidence: AccountViewConfidence,
  explicitChecks: StateCheck[],
): StateCheck[] {
  const checks = explicitChecks.map(cloneStateCheck);
  const subjectsWithExplicitChecks = new Set(
    checks.map((check) => check.subject),
  );

  for (const subject of ACCOUNT_STATE_CHECK_SUBJECTS) {
    if (subjectsWithExplicitChecks.has(subject)) {
      continue;
    }

    const confidenceState = confidence[subject];
    if (confidenceState === 'unknown') {
      checks.push(createFallbackStateCheck(scope, subject, 'startup'));
    } else if (confidenceState === 'stale') {
      checks.push(createFallbackStateCheck(scope, subject, 'stale_state'));
    } else if (confidenceState === 'conflicted') {
      checks.push(
        createFallbackStateCheck(scope, subject, 'conflicting_state'),
      );
    }
  }

  return dedupeStateChecks(checks);
}

/**
 * Stable key for a state check within one account scope.
 */
export function getStateCheckKey(check: StateCheck): string {
  return `${check.subject}:${check.reason}`;
}

/**
 * Clone state checks before exposing them to callers or internal maps.
 */
export function cloneStateCheck(check: StateCheck): StateCheck {
  return {
    ...check,
    scope: copyScope(check.scope),
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
  for (const subject of ACCOUNT_STATE_CHECK_SUBJECTS) {
    next[subject] = 'stale';
  }

  return next;
}

function getStreamHealthStateCheckPlan(status: StreamHealthFact['status']):
  | {
      reason: StateCheckReason;
      priority: StateCheck['priority'];
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

function createFallbackStateCheck(
  scope: AccountScope,
  subject: StateCheckSubject,
  reason: StateCheckReason,
): StateCheck {
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

function dedupeStateChecks(checks: StateCheck[]): StateCheck[] {
  const deduped = new Map<string, StateCheck>();
  for (const check of checks) {
    deduped.set(getStateCheckKey(check), cloneStateCheck(check));
  }

  return Array.from(deduped.values());
}

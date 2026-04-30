import type {
  LocalSubmissionAcceptedFact,
  LocalSubmissionRejectedFact,
  LocalSubmissionUnknownFact,
  StreamHealthFact,
  TerminalEvidenceFact,
} from './facts.js';
import type {
  AccountScope,
  AccountView,
  ChangeSet,
  ConfidenceState,
  HydrationNeed,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedOrderKind,
  NormalizedOrderStatus,
  NormalizedPosition,
  OrderIdentity,
  OrderOwner,
  PositionLifecycle,
  Provenance,
  SnapshotCoverage,
  SnapshotInput,
  SnapshotMode,
  SnapshotSubject,
  StateSource,
  StrategySide,
  TerminalReason,
  TimestampMs,
} from './types.js';
import { copyScope } from './utils.js';

type SnapshotRowForSubject<TSubject extends SnapshotSubject> =
  TSubject extends 'positions'
    ? NormalizedPosition
    : TSubject extends 'openOrders'
      ? NormalizedOrder
      : TSubject extends 'balances'
        ? NormalizedBalance
        : TSubject extends 'fills'
          ? NormalizedFill
          : never;

export interface SyncRowsOptions {
  mode?: SnapshotMode;
  source?: StateSource;
  asOfMs?: TimestampMs;
  coverage?: SnapshotCoverage;
  provenance?: Provenance;
}

export interface StreamUpdateOptions {
  atMs?: TimestampMs;
  receivedAtMs?: TimestampMs;
  exchangeEventTimeMs?: TimestampMs;
  eventId?: string;
  sequence?: string | number;
  provenance?: Provenance;
}

export interface StreamHealthOptions {
  atMs?: TimestampMs;
  reason?: string;
  receivedAtMs?: TimestampMs;
  exchangeEventTimeMs?: TimestampMs;
  eventId?: string;
  sequence?: string | number;
  provenance?: Provenance;
}

export interface OrderAcceptedInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  order: NormalizedOrder;
  acceptedAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface OrderRejectedInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  error: LocalSubmissionRejectedFact['error'];
  rejectedAtMs?: TimestampMs;
}

export interface OrderStatusUnknownInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  error: LocalSubmissionUnknownFact['error'];
  atMs?: TimestampMs;
}

export interface CancelAcceptedInput {
  scope: AccountScope;
  intentId?: string;
  identity: OrderIdentity;
  acceptedAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface OrderNotFoundInput {
  scope: AccountScope;
  identity: OrderIdentity;
  reason?: TerminalReason;
  atMs?: TimestampMs;
}

export interface PositionFilter {
  symbol?: string;
  exchangePositionSide?: string;
  strategySide?: StrategySide;
}

export interface PositionIdentity extends PositionFilter {
  symbol: string;
}

export interface OpenOrderFilter extends OrderIdentity {
  symbol?: string;
  kind?: NormalizedOrderKind;
  status?: NormalizedOrderStatus;
  owner?: OrderOwner;
}

export interface FillFilter extends OrderIdentity {
  symbol?: string;
  exchangeTradeId?: string;
}

export interface ExchangeAccountReadinessOptions {
  requireFills?: boolean;
}

export interface ExchangeAccount {
  scope: AccountScope;
  positions: NormalizedPosition[];
  openOrders: NormalizedOrder[];
  balances: NormalizedBalance[];
  fills: NormalizedFill[];
  lifecycles: PositionLifecycle[];
  readyToTrade: boolean;
  canTrustPositions: boolean;
  canTrustOpenOrders: boolean;
  canTrustBalances: boolean;
  canTrustFills: boolean;
  hydrationRequests: HydrationNeed[];
  hydrationReasons: string[];
  raw: AccountView;
}

/**
 * Build the snapshot input behind exchange-facing REST-style sync methods.
 */
export function createSyncSnapshotInput<TSubject extends SnapshotSubject>(
  scope: AccountScope,
  subject: TSubject,
  rows: SnapshotRowForSubject<TSubject>[],
  defaults: Required<Pick<SyncRowsOptions, 'mode' | 'source'>>,
  options: SyncRowsOptions = {},
): SnapshotInput<SnapshotRowForSubject<TSubject>> {
  return {
    scope: copyScope(scope),
    subject,
    mode: options.mode ?? defaults.mode,
    rows,
    asOfMs: options.asOfMs ?? Date.now(),
    source: options.source ?? defaults.source,
    coverage: options.coverage,
    provenance: options.provenance,
  };
}

/**
 * Build an upsert-style snapshot for a single private stream row.
 */
export function createStreamUpdateSnapshotInput<
  TSubject extends SnapshotSubject,
>(
  scope: AccountScope,
  subject: TSubject,
  row: SnapshotRowForSubject<TSubject>,
  options: StreamUpdateOptions = {},
): SnapshotInput<SnapshotRowForSubject<TSubject>> {
  const provenance = createStreamProvenance(options, row.updatedAtMs);
  return {
    scope: copyScope(scope),
    subject,
    mode: 'upsert-only',
    rows: [row],
    asOfMs: provenance.exchangeEventTimeMs ?? provenance.receivedAtMs,
    source: provenance.source,
    provenance,
  };
}

/**
 * Build the fact behind exchange-facing stream health methods.
 */
export function createStreamHealthFact(
  scope: AccountScope,
  status: StreamHealthFact['status'],
  options: StreamHealthOptions = {},
): StreamHealthFact {
  const atMs = options.atMs ?? options.receivedAtMs ?? Date.now();
  return {
    type: 'stream_health',
    scope: copyScope(scope),
    status,
    reason: options.reason,
    atMs,
    provenance:
      options.provenance ??
      createStreamProvenance(
        {
          ...options,
          receivedAtMs: options.receivedAtMs ?? atMs,
        },
        atMs,
      ),
  };
}

/**
 * Convert the developer-facing accepted-order shape into the reducer fact.
 */
export function createOrderAcceptedFact(
  input: OrderAcceptedInput,
): LocalSubmissionAcceptedFact {
  const acceptedAtMs = input.acceptedAtMs ?? Date.now();
  return {
    type: 'local_submission_accepted',
    scope: copyScope(input.scope),
    intentId: input.intentId,
    clientId: input.clientOrderId,
    order: input.order,
    acceptedAtMs,
    responseSummary: input.responseSummary,
  };
}

/**
 * Convert the developer-facing rejected-order shape into the reducer fact.
 */
export function createOrderRejectedFact(
  input: OrderRejectedInput,
): LocalSubmissionRejectedFact {
  return {
    type: 'local_submission_rejected',
    scope: copyScope(input.scope),
    intentId: input.intentId,
    clientId: input.clientOrderId,
    error: input.error,
    rejectedAtMs: input.rejectedAtMs ?? Date.now(),
  };
}

/**
 * Convert the developer-facing unknown-status shape into the reducer fact.
 */
export function createOrderStatusUnknownFact(
  input: OrderStatusUnknownInput,
): LocalSubmissionUnknownFact {
  return {
    type: 'local_submission_unknown',
    scope: copyScope(input.scope),
    intentId: input.intentId,
    clientId: input.clientOrderId,
    error: input.error,
    atMs: input.atMs ?? Date.now(),
  };
}

/**
 * Convert user-facing terminal order language into the reducer fact.
 */
export function createOrderNotFoundFact(
  input: OrderNotFoundInput,
): TerminalEvidenceFact {
  return {
    type: 'terminal_evidence',
    scope: copyScope(input.scope),
    identity: input.identity,
    reason: input.reason ?? 'unknown_order_cancel_absent_from_hydration',
    atMs: input.atMs ?? Date.now(),
  };
}

/**
 * Convert a cancel acknowledgement into terminal evidence for callers that know
 * the target identity.
 */
export function createCancelAcceptedTerminalFact(
  input: CancelAcceptedInput,
): TerminalEvidenceFact {
  return {
    type: 'terminal_evidence',
    scope: copyScope(input.scope),
    identity: input.identity,
    reason: 'cancelled',
    atMs: input.acceptedAtMs ?? Date.now(),
  };
}

/**
 * Build the human-facing account read model from the reducer view.
 */
export function createExchangeAccount(
  view: AccountView,
  hydrationRequests: HydrationNeed[],
  options: ExchangeAccountReadinessOptions = {},
): ExchangeAccount {
  const canTrustPositions = isTrustedForPlanning(view.confidence.positions);
  const canTrustOpenOrders = isTrustedForPlanning(view.confidence.openOrders);
  const canTrustBalances = isTrustedForPlanning(view.confidence.balances);
  const canTrustFills = isTrustedForPlanning(view.confidence.fills);
  const readyToTrade =
    canTrustPositions &&
    canTrustOpenOrders &&
    canTrustBalances &&
    (!options.requireFills || canTrustFills);

  return {
    scope: copyScope(view.scope),
    positions: view.positions,
    openOrders: view.openOrders,
    balances: view.balances,
    fills: view.fills,
    lifecycles: view.lifecycles,
    readyToTrade,
    canTrustPositions,
    canTrustOpenOrders,
    canTrustBalances,
    canTrustFills,
    hydrationRequests,
    hydrationReasons: [...view.hydrationReasons],
    raw: view,
  };
}

/**
 * Create a no-row change set with a clear warning for facts planned but not yet
 * supported by the reducer.
 */
export function createUnsupportedFactChangeSet(
  scope: AccountScope,
  factType: string,
): ChangeSet {
  return {
    scope: copyScope(scope),
    changed: true,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsTerminal: 0,
    rowsStale: 0,
    confidenceChanged: false,
    lifecycleChanges: [],
    warnings: [
      {
        name: 'unsupported_account_fact',
        scope: copyScope(scope),
        message: `Account fact type is not supported yet: ${factType}.`,
        context: { factType },
      },
    ],
    invariantViolations: [],
  };
}

function createStreamProvenance(
  options: StreamUpdateOptions,
  fallbackAtMs: TimestampMs,
): Provenance {
  if (options.provenance) {
    return options.provenance;
  }

  return {
    source: 'ws',
    receivedAtMs: options.receivedAtMs ?? options.atMs ?? fallbackAtMs,
    exchangeEventTimeMs: options.exchangeEventTimeMs,
    eventId: options.eventId,
    sequence: options.sequence,
  };
}

function isTrustedForPlanning(value: ConfidenceState): boolean {
  return (
    value !== 'unknown' &&
    value !== 'stale' &&
    value !== 'conflicted' &&
    value !== 'paused'
  );
}

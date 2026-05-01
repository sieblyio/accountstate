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
  SyncRequest,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedOrderKind,
  NormalizedOrderStatus,
  NormalizedPosition,
  OrderIdentity,
  OrderIdentityFilter,
  OrderOwner,
  PositionLifecycle,
  Provenance,
  SyncCoverage,
  SnapshotInput,
  SyncMode,
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

/**
 * Options for applying a current-state snapshot, usually from REST sync.
 */
export interface SyncRowsOptions {
  /**
   * Replacement semantics for rows absent from the provided snapshot.
   */
  mode?: SyncMode;
  /**
   * Source label to attach to the snapshot rows and confidence state.
   */
  source?: StateSource;
  /**
   * Exchange or local timestamp that the snapshot represents.
   */
  asOfMs?: TimestampMs;
  /**
   * Optional partial coverage when the snapshot only covers selected symbols.
   */
  coverage?: SyncCoverage;
  /**
   * Full provenance override when the caller has richer source metadata.
   */
  provenance?: Provenance;
}

/**
 * Metadata for one normalized private-stream row update.
 */
export interface StreamUpdateOptions {
  /**
   * Local timestamp for the update when no richer provenance is supplied.
   */
  atMs?: TimestampMs;
  /**
   * Time the parent app received the event.
   */
  receivedAtMs?: TimestampMs;
  /**
   * Time reported by the exchange event, if available.
   */
  exchangeEventTimeMs?: TimestampMs;
  /**
   * Exchange or adapter event id used for debugging/replay.
   */
  eventId?: string;
  /**
   * Exchange stream sequence used for debugging/replay.
   */
  sequence?: string | number;
  /**
   * Full provenance override when the caller has already normalized it.
   */
  provenance?: Provenance;
}

/**
 * Metadata for stream health transitions such as reconnects and gaps.
 */
export interface StreamHealthOptions {
  /**
   * Local timestamp for the health signal.
   */
  atMs?: TimestampMs;
  /**
   * Human-readable reason to surface in warnings and sync requests.
   */
  reason?: string;
  /**
   * Time the parent app observed the health signal.
   */
  receivedAtMs?: TimestampMs;
  /**
   * Time reported by the exchange event, if available.
   */
  exchangeEventTimeMs?: TimestampMs;
  /**
   * Exchange or adapter event id used for debugging/replay.
   */
  eventId?: string;
  /**
   * Exchange stream sequence used for debugging/replay.
   */
  sequence?: string | number;
  /**
   * Full provenance override when the caller has already normalized it.
   */
  provenance?: Provenance;
}

/**
 * Successful order-submission result from the parent exchange client.
 */
export interface OrderAcceptedInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  order: NormalizedOrder;
  acceptedAtMs?: TimestampMs;
  responseSummary?: unknown;
}

/**
 * Rejected order-submission result from the parent exchange client.
 */
export interface OrderRejectedInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  error: LocalSubmissionRejectedFact['error'];
  rejectedAtMs?: TimestampMs;
}

/**
 * Timed-out or indeterminate order-submission result that needs sync.
 */
export interface OrderStatusUnknownInput {
  scope: AccountScope;
  intentId: string;
  clientOrderId?: string;
  error: LocalSubmissionUnknownFact['error'];
  atMs?: TimestampMs;
}

/**
 * Successful cancel response that proves the target order is no longer open.
 */
export interface OrderCancelledInput {
  scope: AccountScope;
  intentId?: string;
  identity: OrderIdentity;
  cancelledAtMs?: TimestampMs;
  responseSummary?: unknown;
}

/**
 * Exchange evidence that an order identity is absent from the open-order set.
 */
export interface OrderNotFoundInput {
  scope: AccountScope;
  identity: OrderIdentity;
  reason?: TerminalReason;
  atMs?: TimestampMs;
}

/**
 * Common filters for reading normalized positions.
 */
export interface PositionFilter {
  symbol?: string;
  exchangePositionSide?: string;
  strategySide?: StrategySide;
}

/**
 * Identity for reading one position without guessing across hedge-mode sides.
 */
export interface PositionIdentity extends PositionFilter {
  symbol: string;
}

/**
 * Common filters for reading normalized open orders.
 */
export interface OpenOrderFilter extends OrderIdentityFilter {
  symbol?: string;
  kind?: NormalizedOrderKind;
  status?: NormalizedOrderStatus;
  owner?: OrderOwner;
}

/**
 * Common filters for reading normalized fills/trades.
 */
export interface FillFilter extends OrderIdentityFilter {
  symbol?: string;
  exchangeTradeId?: string;
}

/**
 * Options controlling which subjects block `readyToTrade`.
 */
export interface ExchangeAccountReadinessOptions {
  requireFills?: boolean;
}

/**
 * Account read model for planning and sync decisions.
 */
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
  syncRequests: SyncRequest[];
  syncReasons: string[];
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
 * Convert accepted-order input into the reducer fact.
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
 * Convert rejected-order input into the reducer fact.
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
 * Convert unknown-status input into the reducer fact.
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
    reason: input.reason ?? 'order_not_found',
    atMs: input.atMs ?? Date.now(),
  };
}

/**
 * Convert a successful cancel response into terminal evidence for callers that
 * know the target identity.
 */
export function createOrderCancelledFact(
  input: OrderCancelledInput,
): TerminalEvidenceFact {
  return {
    type: 'terminal_evidence',
    scope: copyScope(input.scope),
    identity: input.identity,
    reason: 'cancelled',
    atMs: input.cancelledAtMs ?? Date.now(),
  };
}

/**
 * Build the account read model from the reducer view.
 */
export function createExchangeAccount(
  view: AccountView,
  syncRequests: SyncRequest[],
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
  const accountSyncRequests = options.requireFills
    ? syncRequests.map((request) =>
        request.subject === 'fills' && request.priority === 'background'
          ? { ...request, priority: 'immediate' as const }
          : request,
      )
    : syncRequests;

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
    syncRequests: accountSyncRequests,
    syncReasons: [...view.syncReasons],
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
    itemsAdded: 0,
    itemsUpdated: 0,
    itemsRemoved: 0,
    itemsMarkedStale: 0,
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

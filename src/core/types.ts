export type DecimalString = string;
export type TimestampMs = number;

export type ExchangeId = string;
export type AccountId = string;
export type ProductId = string;

export interface AccountScope {
  exchange: ExchangeId;
  accountId: AccountId;
  product: ProductId;
  environment?: 'mainnet' | 'testnet' | 'demo' | string;
}

export type StateSource =
  | 'rest'
  | 'ws'
  | 'local'
  | 'replay'
  | 'manual'
  | 'test';

export interface Provenance {
  source: StateSource;
  receivedAtMs: TimestampMs;
  exchangeEventTimeMs?: TimestampMs;
  snapshotId?: string;
  eventId?: string;
  sequence?: string | number;
}

export type StrategySide = 'LONG' | 'SHORT' | 'FLAT';
export type OrderStrategySide = Exclude<StrategySide, 'FLAT'>;
export type OrderOwner = 'app' | 'manual' | 'unknown';

export interface ManagedOrderMetadata {
  strategyId: string;
  role: 'DCA' | 'TP' | 'SL' | 'TRAIL' | string;
  step?: number;
  lifecycleEpoch?: string;
  replacementGeneration?: number;
  exchangePositionSide?: string;
  strategySide?: OrderStrategySide;
}

export interface NormalizedPosition extends AccountScope {
  symbol: string;
  exchangePositionSide: string;
  strategySide: StrategySide;
  quantity: DecimalString;
  signedQuantity?: DecimalString;
  averageEntry?: DecimalString;
  markPrice?: DecimalString;
  liquidationPrice?: DecimalString;
  marginMode?: string;
  leverage?: DecimalString;
  updatedAtMs: TimestampMs;
  source: StateSource;
  provenance?: Provenance;
  raw?: unknown;
}

export type NormalizedOrderKind =
  | 'regular'
  | 'algo'
  | 'conditional'
  | 'oco'
  | 'unknown';

export type NormalizedOrderStatus =
  | 'new'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'pending_cancel'
  | 'provisional'
  | 'stale'
  | 'unknown';

export interface NormalizedOrder extends AccountScope {
  symbol: string;
  kind: NormalizedOrderKind;
  exchangeOrderId?: string;
  customClientOrderId?: string;
  customTriggerOrderId?: string;
  exchangeTriggerOrderId?: string;
  side: 'BUY' | 'SELL';
  type: string;
  status: NormalizedOrderStatus;
  exchangePositionSide?: string;
  strategySide?: OrderStrategySide;
  quantity?: DecimalString;
  executedQuantity?: DecimalString;
  remainingQuantity?: DecimalString;
  price?: DecimalString;
  averagePrice?: DecimalString;
  triggerPrice?: DecimalString;
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeInForce?: string;
  workingType?: string;
  priceProtect?: boolean;
  owner?: OrderOwner;
  metadata?: ManagedOrderMetadata;
  acceptedAtMs?: TimestampMs;
  createdAtMs?: TimestampMs;
  updatedAtMs: TimestampMs;
  source: StateSource;
  provenance?: Provenance;
  raw?: unknown;
}

export interface NormalizedBalance extends AccountScope {
  asset: string;
  walletBalance?: DecimalString;
  availableBalance?: DecimalString;
  lockedBalance?: DecimalString;
  unrealizedPnl?: DecimalString;
  updatedAtMs: TimestampMs;
  source: StateSource;
  provenance?: Provenance;
  raw?: unknown;
}

export interface NormalizedFill extends AccountScope {
  symbol: string;
  exchangeTradeId?: string;
  exchangeOrderId?: string;
  customClientOrderId?: string;
  customTriggerOrderId?: string;
  side: 'BUY' | 'SELL';
  price: DecimalString;
  quantity: DecimalString;
  quoteQuantity?: DecimalString;
  fee?: DecimalString;
  feeAsset?: string;
  realizedPnl?: DecimalString;
  exchangePositionSide?: string;
  strategySide?: OrderStrategySide;
  executedAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
  source: StateSource;
  provenance?: Provenance;
  raw?: unknown;
}

export interface PositionLifecycle extends AccountScope {
  symbol: string;
  exchangePositionSide: string;
  strategySide: OrderStrategySide;
  lifecycleEpoch: string;
  replacementGeneration: number;
  openedAtMs?: TimestampMs;
  lastQuantity?: DecimalString;
  lastAverageEntry?: DecimalString;
  status: 'open' | 'closing' | 'closed' | 'cleanup_pending' | 'settled';
}

export type ConfidenceState =
  | 'unknown'
  | 'local_only'
  | 'stream_only'
  | 'synced'
  | 'rest_and_stream'
  | 'stale'
  | 'conflicted'
  | 'paused';

export interface AccountViewConfidence {
  positions: ConfidenceState;
  openOrders: ConfidenceState;
  balances: ConfidenceState;
  fills: ConfidenceState;
  filters?: ConfidenceState;
  stream?: ConfidenceState;
}

export interface SubjectWatermark {
  source: StateSource;
  asOfMs: TimestampMs;
  receivedAtMs?: TimestampMs;
  snapshotId?: string;
  eventId?: string;
  sequence?: string | number;
}

export interface AccountWatermarks {
  positions?: SubjectWatermark;
  openOrders?: SubjectWatermark;
  balances?: SubjectWatermark;
  fills?: SubjectWatermark;
  filters?: SubjectWatermark;
  stream?: SubjectWatermark;
}

export interface AccountView {
  scope: AccountScope;
  positions: NormalizedPosition[];
  openOrders: NormalizedOrder[];
  balances: NormalizedBalance[];
  fills: NormalizedFill[];
  lifecycles: PositionLifecycle[];
  confidence: AccountViewConfidence;
  watermarks: AccountWatermarks;
  needsSync: boolean;
  syncReasons: string[];
}

export type SnapshotSubject =
  | 'positions'
  | 'openOrders'
  | 'balances'
  | 'fills'
  | 'filters';

export type SyncMode = 'replace-scope' | 'replace-symbols' | 'upsert-only';

export interface SyncCoverage {
  symbols?: string[];
  orderKinds?: NormalizedOrderKind[];
  positionSides?: string[];
  assets?: string[];
}

export interface SnapshotInput<T> {
  scope: AccountScope;
  subject: SnapshotSubject;
  mode: SyncMode;
  rows: T[];
  asOfMs: TimestampMs;
  source: StateSource;
  coverage?: SyncCoverage;
  provenance?: Provenance;
}

export interface LifecycleChange {
  lifecycle: PositionLifecycle;
  change:
    | 'created'
    | 'updated'
    | 'generation_advanced'
    | 'cleanup_pending'
    | 'settled';
}

export interface StateWarning {
  name: string;
  scope: AccountScope;
  message: string;
  context?: Record<string, unknown>;
}

export interface InvariantViolation {
  name: string;
  severity: 'error' | 'warn';
  scope: AccountScope;
  message: string;
  context?: Record<string, unknown>;
}

export interface ChangeSet {
  scope: AccountScope;
  /**
   * True when the operation changed state, confidence, lifecycle, or warnings.
   */
  changed: boolean;
  /**
   * Number of account-state items added by this operation.
   */
  itemsAdded: number;
  /**
   * Number of existing account-state items updated by this operation.
   */
  itemsUpdated: number;
  /**
   * Number of active account-state items removed because they are closed,
   * absent from an authoritative snapshot, or otherwise known not to be open.
   */
  itemsRemoved: number;
  /**
   * Number of account-state items kept but marked stale.
   */
  itemsMarkedStale: number;
  /**
   * True when the account confidence/readiness changed.
   */
  confidenceChanged: boolean;
  lifecycleChanges: LifecycleChange[];
  warnings: StateWarning[];
}

export type SyncSubject =
  | 'positions'
  | 'openOrders'
  | 'balances'
  | 'fills'
  | 'filters';

export type SyncReason =
  | 'startup'
  | 'stream_reconnected'
  | 'stream_gap'
  | 'submission_unknown'
  | 'provisional_stale'
  | 'stale_state'
  | 'conflicting_state'
  | 'operator_requested';

export interface SyncRequest {
  scope: AccountScope;
  subject: SyncSubject;
  reason: SyncReason;
  priority: 'immediate' | 'soon' | 'background';
  requestedAtMs?: TimestampMs;
}

export interface OrderIdentityFilter {
  exchangeOrderId?: string;
  customClientOrderId?: string;
  customTriggerOrderId?: string;
  exchangeTriggerOrderId?: string;
}

export type OrderIdentity =
  | (OrderIdentityFilter & { exchangeOrderId: string })
  | (OrderIdentityFilter & { customClientOrderId: string })
  | (OrderIdentityFilter & { customTriggerOrderId: string })
  | (OrderIdentityFilter & { exchangeTriggerOrderId: string });

export type TerminalReason =
  | 'filled'
  | 'triggered'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'absent_from_open_order_snapshot'
  | 'order_not_found'
  | 'manual_operator_terminal';

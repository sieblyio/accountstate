import type {
  AccountScope,
  SyncSubject,
  NormalizedBalance,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  OrderIdentity,
  Provenance,
  SnapshotInput,
  StateSource,
  TerminalReason,
  TimestampMs,
} from './types.js';

export type SnapshotRow =
  | NormalizedPosition
  | NormalizedOrder
  | NormalizedBalance
  | NormalizedFill;

export type RestSnapshotFact<T = unknown> = SnapshotInput<T> & {
  type: 'rest_snapshot';
  source: Extract<StateSource, 'rest' | 'replay' | 'test'>;
};

export type PrivateStreamEventFact = NormalizedPrivateEvent;

export type NormalizedPrivateEvent =
  | {
      type: 'position_updated';
      scope: AccountScope;
      position: NormalizedPosition;
      provenance: Provenance;
    }
  | {
      type: 'order_updated';
      scope: AccountScope;
      order: NormalizedOrder;
      provenance: Provenance;
    }
  | {
      type: 'trade_executed';
      scope: AccountScope;
      fill: NormalizedFill;
      provenance: Provenance;
    }
  | {
      type: 'balance_updated';
      scope: AccountScope;
      balance: NormalizedBalance;
      provenance: Provenance;
    }
  | {
      type: 'stream_gap';
      scope: AccountScope;
      reason: string;
      provenance: Provenance;
    };

export interface NormalizedSubmissionError {
  message: string;
  code?: string | number;
  retryable?: boolean;
  raw?: unknown;
}

export interface LocalSubmissionAcceptedFact {
  type: 'local_submission_accepted';
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  order: NormalizedOrder;
  acceptedAtMs: TimestampMs;
  responseSummary?: unknown;
}

export interface LocalSubmissionRejectedFact {
  type: 'local_submission_rejected';
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: NormalizedSubmissionError;
  rejectedAtMs: TimestampMs;
}

export interface LocalSubmissionUnknownFact {
  type: 'local_submission_unknown';
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: NormalizedSubmissionError;
  atMs: TimestampMs;
}

export interface LocalOrderCancelledFact {
  type: 'local_order_cancelled';
  scope: AccountScope;
  intentId: string;
  target?: OrderIdentity;
  cancelledAtMs: TimestampMs;
  responseSummary?: unknown;
}

export interface TerminalEvidenceFact {
  type: 'terminal_evidence';
  scope: AccountScope;
  identity: OrderIdentity;
  reason: TerminalReason;
  atMs: TimestampMs;
}

export interface SyncGapFact {
  type: 'sync_gap';
  scope: AccountScope;
  subject: SyncSubject;
  reason: string;
  atMs: TimestampMs;
}

export interface StreamHealthFact {
  type: 'stream_health';
  scope: AccountScope;
  status: 'connected' | 'reconnected' | 'disconnected' | 'gap';
  reason?: string;
  atMs: TimestampMs;
  provenance?: Provenance;
}

export interface OperatorStateFact {
  type: 'operator_state';
  scope: AccountScope;
  status: 'active' | 'paused';
  reason?: string;
  atMs: TimestampMs;
}

export type AccountFact =
  | RestSnapshotFact
  | PrivateStreamEventFact
  | LocalSubmissionAcceptedFact
  | LocalSubmissionRejectedFact
  | LocalSubmissionUnknownFact
  | LocalOrderCancelledFact
  | TerminalEvidenceFact
  | SyncGapFact
  | StreamHealthFact
  | OperatorStateFact;

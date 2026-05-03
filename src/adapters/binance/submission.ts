import type {
  LocalSubmissionAcceptedFact,
  LocalSubmissionRejectedFact,
  LocalSubmissionUnknownFact,
  TerminalEvidenceFact,
} from '../../core/facts.js';
import {
  createOrderAcceptedFact,
  createOrderCancelledFact,
  createOrderNotFoundFact,
  createOrderRejectedFact,
  createOrderStatusUnknownFact,
} from '../../core/exchangeAccount.js';
import type {
  AccountScope,
  NormalizedOrder,
  OrderIdentity,
  TimestampMs,
} from '../../core/types.js';
import {
  classifyBinanceSubmissionError,
  isBinanceUnknownOrderError,
} from './errors.js';

export interface BinancePlaceAcceptedInput {
  scope: AccountScope;
  intentId: string;
  order: NormalizedOrder;
  customOrderId?: string;
  acceptedAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface BinancePlaceRejectedInput {
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: unknown;
  rejectedAtMs?: TimestampMs;
}

export interface BinancePlaceStatusUnknownInput {
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

export interface BinanceCancelAcceptedInput {
  scope: AccountScope;
  identity: OrderIdentity;
  intentId?: string;
  cancelledAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface BinanceCancelRejectedInput {
  scope: AccountScope;
  identity: OrderIdentity;
  intentId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

export interface BinanceCancelStatusUnknownInput {
  scope: AccountScope;
  identity?: OrderIdentity;
  intentId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

/**
 * Pure helpers for turning observed Binance submission outcomes into
 * account-state facts. They do not call Binance or decide what to submit next.
 */
export const binanceSubmission = {
  placeAccepted,
  placeRejected,
  placeStatusUnknown,
  cancelAccepted,
  cancelRejected,
  cancelStatusUnknown,
} as const;

/**
 * Record a successful place response as a provisional open order while waiting
 * for REST or WebSocket confirmation.
 */
export function placeAccepted(
  input: BinancePlaceAcceptedInput,
): LocalSubmissionAcceptedFact {
  return createOrderAcceptedFact(input);
}

/**
 * Record a rejected place response and add an open-order state check.
 */
export function placeRejected(
  input: BinancePlaceRejectedInput,
): LocalSubmissionRejectedFact {
  return createOrderRejectedFact({
    scope: input.scope,
    intentId: input.intentId,
    customOrderId: input.customOrderId,
    error: classifyBinanceSubmissionError(input.error),
    rejectedAtMs: input.rejectedAtMs,
  });
}

/**
 * Record an indeterminate place response, such as a timeout after submission.
 */
export function placeStatusUnknown(
  input: BinancePlaceStatusUnknownInput,
): LocalSubmissionUnknownFact {
  return createOrderStatusUnknownFact({
    scope: input.scope,
    intentId: input.intentId,
    customOrderId: input.customOrderId,
    error: classifyBinanceSubmissionError(input.error),
    atMs: input.atMs,
  });
}

/**
 * Record a successful cancel response as terminal evidence for the target
 * order identity.
 */
export function cancelAccepted(
  input: BinanceCancelAcceptedInput,
): TerminalEvidenceFact {
  return createOrderCancelledFact({
    scope: input.scope,
    intentId: input.intentId,
    identity: input.identity,
    cancelledAtMs: input.cancelledAtMs,
    responseSummary: input.responseSummary,
  });
}

/**
 * Record a rejected cancel response. Binance's unknown-order error means the
 * order is already absent; other cancel failures leave status unknown and
 * add an open-order state check.
 */
export function cancelRejected(
  input: BinanceCancelRejectedInput,
): TerminalEvidenceFact | LocalSubmissionUnknownFact {
  if (isBinanceUnknownOrderError(input.error)) {
    return createOrderNotFoundFact({
      scope: input.scope,
      identity: input.identity,
      reason: 'order_not_found',
      atMs: input.atMs,
    });
  }

  return cancelStatusUnknown(input);
}

/**
 * Record an indeterminate cancel outcome when the exchange did not prove
 * whether the target order is still open.
 */
export function cancelStatusUnknown(
  input: BinanceCancelStatusUnknownInput,
): LocalSubmissionUnknownFact {
  return createOrderStatusUnknownFact({
    scope: input.scope,
    intentId:
      input.intentId ??
      orderIdentityLabel(input.identity) ??
      'cancel-status-unknown',
    customOrderId: customOrderIdFromIdentity(input.identity),
    error: classifyBinanceSubmissionError(input.error),
    atMs: input.atMs,
  });
}

function customOrderIdFromIdentity(
  identity: OrderIdentity | undefined,
): string | undefined {
  return identity?.customOrderId;
}

function orderIdentityLabel(
  identity: OrderIdentity | undefined,
): string | undefined {
  return (
    identity?.customOrderId ??
    identity?.customTriggerOrderId ??
    identity?.exchangeOrderId ??
    identity?.exchangeTriggerOrderId
  );
}

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
  classifyBybitSubmissionError,
  isBybitUnknownOrderError,
} from './errors.js';

export interface BybitPlaceAcceptedInput {
  scope: AccountScope;
  intentId: string;
  order: NormalizedOrder;
  customOrderId?: string;
  acceptedAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface BybitPlaceRejectedInput {
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: unknown;
  rejectedAtMs?: TimestampMs;
}

export interface BybitPlaceStatusUnknownInput {
  scope: AccountScope;
  intentId: string;
  customOrderId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

export interface BybitCancelAcceptedInput {
  scope: AccountScope;
  identity: OrderIdentity;
  intentId?: string;
  cancelledAtMs?: TimestampMs;
  responseSummary?: unknown;
}

export interface BybitCancelRejectedInput {
  scope: AccountScope;
  identity: OrderIdentity;
  intentId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

export interface BybitCancelStatusUnknownInput {
  scope: AccountScope;
  identity?: OrderIdentity;
  intentId?: string;
  error: unknown;
  atMs?: TimestampMs;
}

/**
 * Pure helpers for turning observed Bybit submission outcomes into
 * account-state facts. They do not call Bybit or decide what to submit next.
 */
export const bybitSubmission = {
  placeAccepted,
  placeRejected,
  placeStatusUnknown,
  cancelAccepted,
  cancelRejected,
  cancelStatusUnknown,
} as const;

/**
 * Record a successful place response as provisional local evidence while
 * waiting for REST or WebSocket confirmation.
 */
export function placeAccepted(
  input: BybitPlaceAcceptedInput,
): LocalSubmissionAcceptedFact {
  return createOrderAcceptedFact(input);
}

/**
 * Record a rejected place response and add an open-order state check.
 */
export function placeRejected(
  input: BybitPlaceRejectedInput,
): LocalSubmissionRejectedFact {
  return createOrderRejectedFact({
    scope: input.scope,
    intentId: input.intentId,
    customOrderId: input.customOrderId,
    error: classifyBybitSubmissionError(input.error),
    rejectedAtMs: input.rejectedAtMs,
  });
}

/**
 * Record an indeterminate place response, such as a timeout after submission.
 */
export function placeStatusUnknown(
  input: BybitPlaceStatusUnknownInput,
): LocalSubmissionUnknownFact {
  return createOrderStatusUnknownFact({
    scope: input.scope,
    intentId: input.intentId,
    customOrderId: input.customOrderId,
    error: classifyBybitSubmissionError(input.error),
    atMs: input.atMs,
  });
}

/**
 * Record a successful cancel response as terminal evidence for the target
 * order identity.
 */
export function cancelAccepted(
  input: BybitCancelAcceptedInput,
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
 * Record a rejected cancel response. Bybit's unknown-order error means the
 * order is already absent; other cancel failures leave status unknown and
 * add an open-order state check.
 */
export function cancelRejected(
  input: BybitCancelRejectedInput,
): TerminalEvidenceFact | LocalSubmissionUnknownFact {
  if (isBybitUnknownOrderError(input.error)) {
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
  input: BybitCancelStatusUnknownInput,
): LocalSubmissionUnknownFact {
  return createOrderStatusUnknownFact({
    scope: input.scope,
    intentId:
      input.intentId ??
      orderIdentityLabel(input.identity) ??
      'cancel-status-unknown',
    customOrderId: customOrderIdFromIdentity(input.identity),
    error: classifyBybitSubmissionError(input.error),
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

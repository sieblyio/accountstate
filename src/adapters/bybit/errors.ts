import type { NormalizedSubmissionError } from '../../core/facts.js';

const RETRYABLE_ERROR_CODES = new Set([10000, 10006, 10016, 10019]);

/**
 * Return true when an SDK/REST response exposes the requested Bybit error code.
 */
export function isBybitApiErrorCode(error: unknown, code: number): boolean {
  const extracted = extractBybitApiErrorCode(error);
  return extracted !== undefined && Number(extracted) === code;
}

/**
 * Bybit V5 uses 110001 for missing orders and too-late cancel/amend cases.
 */
export function isBybitUnknownOrderError(error: unknown): boolean {
  return isBybitApiErrorCode(error, 110001);
}

/**
 * Return true for Bybit's narrow idempotent amend no-op response.
 */
export function isBybitAmendNoopError(error: unknown): boolean {
  return (
    isBybitApiErrorCode(error, 10001) &&
    /order not modified/i.test(extractBybitErrorMessage(error))
  );
}

/**
 * Bybit V5 uses 110072 when an orderLinkId has already been used.
 */
export function isBybitDuplicateOrderIdError(error: unknown): boolean {
  return isBybitApiErrorCode(error, 110072);
}

/**
 * Bybit V5 uses 110017 for reduce-only quantity failures such as attempting a
 * reduce-only order while the matching position is already flat.
 */
export function isBybitOrderQuantityWouldBeZeroError(
  error: unknown,
): boolean {
  return isBybitApiErrorCode(error, 110017);
}

/**
 * Return true for successful Bybit REST business responses.
 */
export function isBybitBusinessSuccess(response: unknown): boolean {
  return isBybitApiErrorCode(response, 0);
}

/**
 * Convert a Bybit SDK/REST error or nonzero retCode response into the store's
 * submission-error shape.
 */
export function classifyBybitSubmissionError(
  error: unknown,
): NormalizedSubmissionError {
  const code = extractBybitApiErrorCode(error);
  return {
    message: extractBybitErrorMessage(error),
    code,
    retryable:
      typeof code === 'number' ? RETRYABLE_ERROR_CODES.has(code) : undefined,
    raw: error,
  };
}

function extractBybitApiErrorCode(
  error: unknown,
): string | number | undefined {
  const direct = readCode(error);
  if (direct !== undefined) {
    return direct;
  }

  if (!isRecord(error)) {
    return undefined;
  }

  return (
    readCode(error['body']) ??
    readCode(error['response']) ??
    readCode(error['data']) ??
    readCode(error['cause']) ??
    readCode(error['error'])
  );
}

function readCode(value: unknown): string | number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = value['retCode'] ?? value['code'] ?? value['statusCode'];
  return typeof code === 'number' || typeof code === 'string'
    ? code
    : undefined;
}

function extractBybitErrorMessage(error: unknown): string {
  const direct = readMessage(error);
  if (direct) {
    return direct;
  }

  if (!isRecord(error)) {
    return String(error);
  }

  return (
    readMessage(error['body']) ??
    readMessage(error['response']) ??
    readMessage(error['data']) ??
    readMessage(error['cause']) ??
    readMessage(error['error']) ??
    'Bybit request failed'
  );
}

function readMessage(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const message = value['retMsg'] ?? value['message'] ?? value['msg'];
  return typeof message === 'string' ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

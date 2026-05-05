import type { NormalizedSubmissionError } from '../../core/facts.js';

const RETRYABLE_ERROR_CODES = new Set([-1001, -1003, -1006, -1007, -1021]);
const UNKNOWN_ORDER_ERROR_CODES = new Set([-2011, -2013]);

/**
 * Return true when an SDK/rest error exposes the requested Binance error code.
 */
export function isBinanceApiErrorCode(error: unknown, code: number): boolean {
  const extracted = extractBinanceApiErrorCode(error);
  return extracted !== undefined && Number(extracted) === code;
}

/**
 * Binance uses -2011 and -2013 for absent-order cases.
 */
export function isBinanceUnknownOrderError(error: unknown): boolean {
  const code = extractBinanceApiErrorCode(error);
  return typeof code === 'number'
    ? UNKNOWN_ORDER_ERROR_CODES.has(code)
    : UNKNOWN_ORDER_ERROR_CODES.has(Number(code));
}

/**
 * Binance uses -5027 when an amend request matches the current order.
 */
export function isBinanceNoNeedToModifyError(error: unknown): boolean {
  return isBinanceApiErrorCode(error, -5027);
}

/**
 * Binance uses -2021 when a trigger order would fire immediately.
 */
export function isBinanceOrderWouldImmediatelyTriggerError(
  error: unknown,
): boolean {
  return isBinanceApiErrorCode(error, -2021);
}

/**
 * Binance uses -1106 when a parameter is not required or not allowed for the
 * submitted order shape.
 */
export function isBinanceParameterNotRequiredOrAllowedError(
  error: unknown,
): boolean {
  return isBinanceApiErrorCode(error, -1106);
}

/**
 * Binance uses -4509 for requests that require an open position when no
 * matching position is available.
 */
export function isBinancePositionUnavailableError(error: unknown): boolean {
  return isBinanceApiErrorCode(error, -4509);
}

/**
 * Binance uses -2027 for max leverage or position-limit failures.
 */
export function isBinanceRiskLimitOrLeverageError(error: unknown): boolean {
  return isBinanceApiErrorCode(error, -2027);
}

/**
 * Convert a Binance SDK/rest error into the store's submission-error shape.
 */
export function classifyBinanceSubmissionError(
  error: unknown,
): NormalizedSubmissionError {
  const code = extractBinanceApiErrorCode(error);
  return {
    message: extractBinanceErrorMessage(error),
    code,
    retryable:
      typeof code === 'number' ? RETRYABLE_ERROR_CODES.has(code) : undefined,
    raw: error,
  };
}

function extractBinanceApiErrorCode(
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
    readCode(error['cause'])
  );
}

function readCode(value: unknown): string | number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = value['code'] ?? value['exchangeCode'];
  return typeof code === 'number' || typeof code === 'string'
    ? code
    : undefined;
}

function extractBinanceErrorMessage(error: unknown): string {
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
    'Binance request failed'
  );
}

function readMessage(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const message = value['msg'] ?? value['message'] ?? value['exchangeMessage'];
  return typeof message === 'string' ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

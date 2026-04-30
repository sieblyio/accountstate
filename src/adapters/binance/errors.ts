import type { NormalizedSubmissionError } from '../../core/facts.js';

const RETRYABLE_ERROR_CODES = new Set([-1001, -1003, -1006, -1007, -1021]);

/**
 * Return true when an SDK/rest error exposes the requested Binance error code.
 */
export function isBinanceApiErrorCode(error: unknown, code: number): boolean {
  const extracted = extractBinanceApiErrorCode(error);
  return extracted !== undefined && Number(extracted) === code;
}

/**
 * Binance uses -2011 for "Unknown order sent" and related absent-order cases.
 */
export function isBinanceUnknownOrderError(error: unknown): boolean {
  return isBinanceApiErrorCode(error, -2011);
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

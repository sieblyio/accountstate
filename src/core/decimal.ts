import type { DecimalString } from './types.js';

const DECIMAL_STRING_PATTERN = /^[+-]?(?:\d+|\d*\.\d+)$/;

/**
 * Check for plain decimal notation at the exchange-state boundary.
 *
 * Scientific notation is intentionally rejected so adapters preserve the exact
 * decimal strings they received or intentionally normalized.
 */
export function isDecimalString(value: string): value is DecimalString {
  return DECIMAL_STRING_PATTERN.test(value);
}

/**
 * Validate and return a decimal string for normalized exchange state.
 */
export function assertDecimalString(value: string): DecimalString {
  if (!isDecimalString(value)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }

  return value;
}

/**
 * Convert simple string/number inputs into the normalized decimal-string type.
 *
 * Callers that care about request-grade precision should pass strings rather
 * than JavaScript numbers.
 */
export function toDecimalString(value: string | number): DecimalString {
  const stringValue = String(value);
  return assertDecimalString(stringValue);
}

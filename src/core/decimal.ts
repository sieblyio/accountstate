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
  const stringValue =
    typeof value === 'number' ? numberToPlainDecimalString(value) : value;
  return assertDecimalString(stringValue);
}

function numberToPlainDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid decimal number: ${value}`);
  }

  const raw = String(value);
  if (!/[eE]/.test(raw)) {
    return raw;
  }

  const [coefficient, exponentText] = raw.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const sign = coefficient.startsWith('-') ? '-' : '';
  const unsignedCoefficient = coefficient.replace(/^[+-]/, '');
  const [integerPart, fractionalPart = ''] = unsignedCoefficient.split('.');
  const digits = `${integerPart}${fractionalPart}`;
  const significantDigits = digits.replace(/^0+(?=\d)/, '');

  if (/^0+$/.test(significantDigits)) {
    return '0';
  }

  const decimalIndex = integerPart.length + exponent;
  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(Math.abs(decimalIndex))}${significantDigits}`;
  }

  if (decimalIndex >= significantDigits.length) {
    return `${sign}${significantDigits}${'0'.repeat(
      decimalIndex - significantDigits.length,
    )}`;
  }

  return `${sign}${significantDigits.slice(
    0,
    decimalIndex,
  )}.${significantDigits.slice(decimalIndex)}`;
}

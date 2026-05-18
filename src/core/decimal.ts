import type { DecimalString } from './types.js';

const DECIMAL_STRING_PATTERN = /^[+-]?(?:\d+|\d*\.\d+)$/;
const SCIENTIFIC_DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+|\d*\.\d+)[eE][+-]?\d+$/;

/**
 * Check for plain decimal notation at the normalized exchange-state boundary.
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
 * than JavaScript numbers. Exchange adapter inputs may use scientific notation;
 * normalized account state always exposes plain decimal strings.
 */
export function toDecimalString(value: string | number): DecimalString {
  const stringValue =
    typeof value === 'number'
      ? numberToPlainDecimalString(value)
      : stringToPlainDecimalString(value);
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

  return scientificDecimalStringToPlain(raw);
}

function stringToPlainDecimalString(value: string): string {
  if (!SCIENTIFIC_DECIMAL_STRING_PATTERN.test(value)) {
    return value;
  }

  return scientificDecimalStringToPlain(value);
}

function scientificDecimalStringToPlain(value: string): string {
  const [coefficient, exponentText] = value.toLowerCase().split('e');
  const exponent = Number(exponentText);

  if (!Number.isInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error(`Invalid decimal string: ${value}`);
  }

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

import type { DecimalString } from './types.js';

const DECIMAL_STRING_PATTERN = /^[+-]?(?:\d+|\d*\.\d+)$/;

export function isDecimalString(value: string): value is DecimalString {
  return DECIMAL_STRING_PATTERN.test(value);
}

export function assertDecimalString(value: string): DecimalString {
  if (!isDecimalString(value)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }

  return value;
}

export function toDecimalString(value: string | number): DecimalString {
  const stringValue = String(value);
  return assertDecimalString(stringValue);
}

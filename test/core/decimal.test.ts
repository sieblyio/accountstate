import { toDecimalString } from '../../src/core/decimal';

describe('decimal conversion', () => {
  it('keeps decimal strings unchanged', () => {
    expect(toDecimalString('0.00000001')).toBe('0.00000001');
    expect(toDecimalString('-12.3400')).toBe('-12.3400');
  });

  it('expands finite numeric scientific notation into plain decimals', () => {
    expect(toDecimalString(1e-8)).toBe('0.00000001');
    expect(toDecimalString(-1.23e-7)).toBe('-0.000000123');
    expect(toDecimalString(1.23e21)).toBe('1230000000000000000000');
  });

  it('expands exchange decimal strings in scientific notation into plain decimals', () => {
    expect(toDecimalString('7.199E-5')).toBe('0.00007199');
    expect(toDecimalString('1.2300e+2')).toBe('123.00');
    expect(toDecimalString('-4.5E-3')).toBe('-0.0045');
    expect(toDecimalString('0e+8')).toBe('0');
  });

  it('rejects non-finite numeric values', () => {
    expect(() => toDecimalString(Number.POSITIVE_INFINITY)).toThrow(
      'Invalid decimal number: Infinity',
    );
    expect(() => toDecimalString(Number.NaN)).toThrow(
      'Invalid decimal number: NaN',
    );
  });

  it('rejects decimal strings with unreasonable exponents', () => {
    expect(() => toDecimalString('1e10001')).toThrow(
      'Invalid decimal string: 1e10001',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { parseRetryAfter } from './errors.ts';
import {
  compareMoney,
  createMoneyFormatter,
  formatMoney,
  formatTaxRate,
  fromMinorUnits,
  isZeroMoney,
  toMinorUnits,
} from './money.ts';

describe('money', () => {
  it('converts to and from minor units without floats', () => {
    expect(toMinorUnits('19.99')).toBe(1999n);
    expect(toMinorUnits('0.1')).toBe(10n);
    expect(toMinorUnits('-3.50')).toBe(-350n);
    expect(toMinorUnits('12')).toBe(1200n);
    expect(toMinorUnits('1.2300')).toBe(123n);
    expect(toMinorUnits('90071992547409.93')).toBe(9007199254740993n);
    expect(() => toMinorUnits('1.234')).toThrow(TypeError);
    expect(() => toMinorUnits('abc')).toThrow(TypeError);
    expect(fromMinorUnits(1999n)).toBe('19.99');
    expect(fromMinorUnits(5n)).toBe('0.05');
    expect(fromMinorUnits(-350n)).toBe('-3.50');
    expect(fromMinorUnits(0n)).toBe('0.00');
  });

  it('compares amounts', () => {
    expect(compareMoney('9.50', '10.00')).toBe(-1);
    expect(compareMoney('10.0', '10.00')).toBe(0);
    expect(compareMoney('0.30', '0.1')).toBe(1);
    expect(isZeroMoney('0.00')).toBe(true);
    expect(isZeroMoney('0.01')).toBe(false);
  });

  it('formats with Intl.NumberFormat from the decimal string', () => {
    expect(formatMoney('1234.5', 'EUR', { locale: 'en-IE' })).toBe('€1,234.50');
    expect(formatMoney('1234.50', 'EUR', { locale: 'nl-NL' }).replace(/\s/g, ' ')).toBe('€ 1.234,50');
    expect(formatMoney('0.10', 'EUR', { locale: 'en-IE', currencyDisplay: 'code' })).toMatch(/^EUR\s0\.10$/);
    expect(formatMoney('99999999999999.99', 'EUR', { locale: 'en-IE' })).toBe('€99,999,999,999,999.99');
    expect(() => formatMoney('ten', 'EUR')).toThrow(TypeError);
    const sek = createMoneyFormatter('SEK', { locale: 'sv-SE' });
    expect(sek('100.00').replace(/\s/g, ' ')).toBe('100,00 kr');
  });

  it('formats tax rates as percentages', () => {
    expect(formatTaxRate('21.00', 'en')).toBe('21%');
    expect(formatTaxRate('5.50', 'en')).toBe('5.5%');
    expect(formatTaxRate('0.00', 'en')).toBe('0%');
    expect(formatTaxRate('100', 'en')).toBe('100%');
    expect(formatTaxRate('9', 'en')).toBe('9%');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('45')).toBe(45);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(parseRetryAfter('Sat, 21 Nov 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Sat, 21 Nov 2026 11:00:00 GMT', now)).toBe(0);
  });
});

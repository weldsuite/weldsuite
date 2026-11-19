import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, formatNumber, isoDatePart, toNumber, toNumberOrNull } from './numbers';

describe('toNumber and toNumberOrNull', () => {
  it('reads the text the API sends and falls back to 0 (or null) for anything else', () => {
    expect(toNumber('12.5000')).toBe(12.5);
    expect(toNumber(7)).toBe(7);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumberOrNull('3.25')).toBe(3.25);
    expect(toNumberOrNull(0)).toBe(0);
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull('')).toBeNull();
    expect(toNumberOrNull('abc')).toBeNull();
    expect(toNumberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatMoney', () => {
  it('formats in the currency, with a plain number when there is none', () => {
    expect(formatMoney('1234.5', 'EUR', 'en-US')).toBe('€1,234.50');
    expect(formatMoney('1234.5', null, 'en-US')).toBe('1,234.50');
  });

  it('shows the code next to a plain number for an invalid currency code', () => {
    expect(formatMoney('10', 'NOT-A-CODE', 'en-US')).toBe('NOT-A-CODE 10.00');
  });
});

describe('formatNumber', () => {
  it('limits the decimals and leaves a missing value empty', () => {
    expect(formatNumber('12.345', 1, 'en-US')).toBe('12.3');
    expect(formatNumber(1500, 0, 'en-US')).toBe('1,500');
    expect(formatNumber(null)).toBe('');
  });
});

describe('isoDatePart', () => {
  it('keeps the date of an ISO timestamp and refuses anything else', () => {
    expect(isoDatePart('2026-11-18T10:00:00Z')).toBe('2026-11-18');
    expect(isoDatePart('18/11/2026')).toBeNull();
    expect(isoDatePart(null)).toBeNull();
  });
});

describe('formatDate', () => {
  it('formats a date or a timestamp for the locale, empty when missing or invalid', () => {
    expect(formatDate('2026-11-18', 'en-US')).toBe('Nov 18, 2026');
    expect(formatDate('2026-11-18T12:00:00', 'en-US')).toBe('Nov 18, 2026');
    expect(formatDate(null)).toBe('');
    expect(formatDate('not a date')).toBe('');
  });
});

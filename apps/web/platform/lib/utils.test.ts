import { describe, it, expect } from 'vitest';
import {
  cn,
  formatCurrency,
  formatPercentage,
  formatDate,
  formatDateTime,
  formatNumber,
  calculateDaysOverdue,
  getAccountTypeColor,
  getStatusColor,
} from './utils';

describe('cn (className merge)', () => {
  it('joins truthy classes', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops conflicting Tailwind classes — last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('bg-red-100', 'bg-blue-100')).toBe('bg-blue-100');
  });

  it('handles arrays, objects, and falsy values', () => {
    expect(cn(['a', null, undefined], { b: true, c: false }, false)).toBe('a b');
  });
});

describe('formatCurrency', () => {
  it('formats USD with 2 decimal places and currency symbol', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('respects the currency override', () => {
    // Intl uses "EUR" with the locale's symbol position — match by both pieces.
    const result = formatCurrency(99.9, 'EUR');
    expect(result).toContain('99.90');
    expect(result).toContain('€');
  });

  it('rounds when more than two decimal places are passed in', () => {
    expect(formatCurrency(1.005)).toMatch(/\$1\.0(0|1)/); // rounding mode varies by Intl impl
  });
});

describe('formatPercentage', () => {
  it('multiplies by 100 and appends %', () => {
    expect(formatPercentage(0.125)).toBe('12.50%');
  });

  it('handles zero', () => {
    expect(formatPercentage(0)).toBe('0.00%');
  });
});

describe('formatDate / formatDateTime', () => {
  it('formats a Date in short en-US shape', () => {
    expect(formatDate(new Date('2025-03-15T12:00:00Z'))).toMatch(/Mar 15, 2025/);
  });

  it('formats an ISO string the same way', () => {
    expect(formatDate('2025-03-15T12:00:00Z')).toMatch(/Mar 15, 2025/);
  });

  it('formatDateTime includes hour + minute', () => {
    // Match the date and the presence of a colon for the time part —
    // exact time depends on the test runner's local timezone.
    const out = formatDateTime('2025-03-15T12:00:00Z');
    expect(out).toMatch(/Mar 15, 2025/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('formatNumber', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('calculateDaysOverdue', () => {
  it('returns 0 for a future date', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    expect(calculateDaysOverdue(future)).toBe(0);
  });

  it('returns whole days for a past date', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const days = calculateDaysOverdue(tenDaysAgo);
    expect(days).toBeGreaterThanOrEqual(9);
    expect(days).toBeLessThanOrEqual(10);
  });
});

describe('getAccountTypeColor', () => {
  it.each([
    ['ASSET', 'blue'],
    ['LIABILITY', 'yellow'],
    ['EQUITY', 'purple'],
    ['REVENUE', 'green'],
    ['EXPENSE', 'red'],
  ])('returns the %s color class', (type, hue) => {
    expect(getAccountTypeColor(type)).toContain(hue);
  });

  it('falls back to gray for unknown types', () => {
    expect(getAccountTypeColor('UNKNOWN')).toContain('gray');
  });
});

describe('getStatusColor', () => {
  it('PAID maps to green', () => {
    expect(getStatusColor('PAID')).toContain('green');
  });

  it('OVERDUE maps to red', () => {
    expect(getStatusColor('OVERDUE')).toContain('red');
  });

  it('unknown status falls back to gray', () => {
    expect(getStatusColor('SOMETHING_NEW')).toContain('gray');
  });
});

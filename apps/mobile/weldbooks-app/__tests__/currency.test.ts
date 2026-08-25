import {
  toNumber,
  formatCurrency,
  formatCompactCurrency,
  parseAmount,
  formatPercent,
} from '@/lib/currency';

/** Intl inserts non-breaking/narrow spaces; compare on digits and symbols. */
function normalize(value: string): string {
  return value.replace(/ | |\s/g, ' ');
}

describe('toNumber', () => {
  it('parses the decimal strings app-api returns for money', () => {
    expect(toNumber('123.45')).toBe(123.45);
    expect(toNumber('0')).toBe(0);
    expect(toNumber('-99.99')).toBe(-99.99);
  });

  it('falls back to 0 for null, undefined and unparseable input', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('not a number')).toBe(0);
    expect(toNumber('')).toBe(0);
  });

  it('rejects non-finite numbers rather than propagating them into totals', () => {
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('formatCurrency', () => {
  it('formats in the given currency', () => {
    expect(normalize(formatCurrency('1234.5', 'EUR'))).toContain('1.234,50');
    expect(normalize(formatCurrency(10, 'USD'))).toContain('10,00');
  });

  it('uses English grouping when the profile language is English', () => {
    expect(normalize(formatCurrency('1234.5', 'EUR', 'en-GB'))).toContain('1,234.50');
  });

  it('renders a bad amount as zero in the right currency, not a hardcoded euro', () => {
    // The previous implementation returned the literal '€0.00' here even for USD.
    expect(normalize(formatCurrency('oops', 'USD'))).toContain('0,00');
    expect(formatCurrency('oops', 'USD')).not.toContain('€');
  });
});

describe('formatCompactCurrency', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatCompactCurrency(1500, 'EUR')).toMatch(/1[.,]5/);
    expect(formatCompactCurrency(2_400_000, 'EUR')).toMatch(/2[.,]4/);
  });

  it('keeps small amounts exact', () => {
    expect(normalize(formatCompactCurrency(42.5, 'EUR'))).toContain('42,50');
  });

  it('abbreviates large negatives instead of falling through to the full format', () => {
    // The old implementation compared the signed value against 1_000, so
    // negative balances were never abbreviated.
    const result = formatCompactCurrency(-2500, 'EUR');
    expect(result).toMatch(/2[.,]5/);
    expect(result).toContain('-');
  });
});

describe('parseAmount', () => {
  it('parses European format where comma is the decimal separator', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('12,50')).toBe(12.5);
  });

  it('parses US format where period is the decimal separator', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('12.50')).toBe(12.5);
  });

  it('strips currency symbols and stray text', () => {
    expect(parseAmount('€ 99,95')).toBe(99.95);
  });

  it('returns 0 rather than NaN for empty or junk input', () => {
    // A NaN here would flow into a line total and be sent to app-api.
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
  });
});

describe('formatPercent', () => {
  it('formats to one decimal by default', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
  });

  it('guards against a non-finite margin from a zero-revenue period', () => {
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('0%');
  });
});

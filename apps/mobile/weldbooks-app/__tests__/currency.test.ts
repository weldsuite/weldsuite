import {
  toNumber,
  formatCurrency,
  formatCompactCurrency,
  parseAmount,
  formatPercent,
} from '@/lib/currency';

/** Intl inserts non-breaking/narrow spaces; compare on digits and symbols. */
function normalize(value: string): string {
  return value.replace(/ | |\s/g, ' ');
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
  it('formats a US entity as $1,234.56', () => {
    expect(normalize(formatCurrency('1234.56', 'USD', 'en-US'))).toBe('$1,234.56');
    expect(normalize(formatCurrency(-1234.5, 'USD', 'en-US'))).toBe('-$1,234.50');
  });

  it('formats a Dutch entity with a decimal comma', () => {
    expect(normalize(formatCurrency('1234.5', 'EUR', 'nl-NL'))).toContain('1.234,50');
    expect(normalize(formatCurrency(10, 'USD', 'nl-NL'))).toContain('10,00');
  });

  it('uses English grouping for an English-language user with a euro entity', () => {
    expect(normalize(formatCurrency('1234.5', 'EUR', 'en-GB'))).toContain('1,234.50');
  });

  it('groups an Indian entity in lakhs', () => {
    expect(normalize(formatCurrency(1234567.5, 'INR', 'en-IN'))).toContain('12,34,567.50');
  });

  it('always shows two decimals, whatever the locale', () => {
    expect(formatCurrency(5, 'USD', 'en-US')).toBe('$5.00');
    expect(normalize(formatCurrency(5, 'EUR', 'nl-NL'))).toContain('5,00');
  });

  it('renders a bad amount as zero in the right currency, not a hardcoded euro', () => {
    expect(normalize(formatCurrency('oops', 'USD', 'en-US'))).toBe('$0.00');
    expect(formatCurrency('oops', 'USD', 'en-US')).not.toContain('€');
  });

  it('shows the figure rather than crashing when the currency code is missing or malformed', () => {
    expect(formatCurrency(1234.5, '', 'en-US')).toBe('1,234.50');
    expect(formatCurrency(1234.5, 'EURO', 'en-US')).toBe('1,234.50');
    expect(formatCurrency(1234.5, '€', 'nl-NL')).toBe('1.234,50');
  });

  it('accepts a lower-case currency code', () => {
    expect(formatCurrency(1, 'usd', 'en-US')).toBe('$1.00');
  });
});

describe('formatCompactCurrency', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatCompactCurrency(1500, 'USD', 'en-US')).toBe('$1.5K');
    expect(formatCompactCurrency(2_400_000, 'USD', 'en-US')).toBe('$2.4M');
    expect(formatCompactCurrency(1500, 'EUR', 'nl-NL')).toMatch(/1[.,]5/);
  });

  it('keeps small amounts exact', () => {
    expect(formatCompactCurrency(42.5, 'USD', 'en-US')).toBe('$42.50');
    expect(normalize(formatCompactCurrency(42.5, 'EUR', 'nl-NL'))).toContain('42,50');
  });

  it('abbreviates large negatives instead of falling through to the full format', () => {
    // The old implementation compared the signed value against 1_000, so
    // negative balances were never abbreviated.
    const result = formatCompactCurrency(-2500, 'USD', 'en-US');
    expect(result).toBe('-$2.5K');
  });

  it('falls back to the plain figure when the currency is unusable', () => {
    expect(formatCompactCurrency(2500, '', 'en-US')).toBe('2,500.00');
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
    expect(parseAmount('$1,299.00')).toBe(1299);
  });

  it('reads a lone "1,234" as thousands in an English locale and as a decimal comma otherwise', () => {
    // The two formats collide here, so the locale the user works in decides.
    expect(parseAmount('1,234', 'en-US')).toBe(1234);
    expect(parseAmount('1,234,567', 'en-US')).toBe(1_234_567);
    expect(parseAmount('-1,500', 'en-US')).toBe(-1500);
    expect(parseAmount('1,234', 'nl-NL')).toBe(1.234);
    expect(parseAmount('1,234')).toBe(1.234);
  });

  it('keeps an unambiguous decimal comma as a decimal even in an English locale', () => {
    expect(parseAmount('12,5', 'en-US')).toBe(12.5);
    expect(parseAmount('12,50', 'en-US')).toBe(12.5);
  });

  it('returns 0 rather than NaN for empty or junk input', () => {
    // A NaN here would flow into a line total and be sent to app-api.
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount('', 'en-US')).toBe(0);
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

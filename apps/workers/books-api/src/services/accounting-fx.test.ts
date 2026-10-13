import { describe, expect, it } from 'vitest';
import { calculateFxGainLoss, toBaseCurrency } from './accounting-currency';
import { formatRate, isForeignCurrency, parseRate } from './accounting-fx';
import { exchangeRateSchema } from '../lib/exchange-rate-schema';

describe('exchange rate convention: foreign units per base unit', () => {
  it('books 1000 USD at 1.25 USD per EUR as 800 EUR', () => {
    expect(toBaseCurrency(1000, 1.25)).toBe(800);
    expect(toBaseCurrency(108, 1.08)).toBe(100);
  });

  it('a payment worth more base currency than the document carried is positive', () => {
    // Booked at 1.25 (800 EUR); paid at 1.0 (1000 EUR): +200. Paid at 1.6 (625 EUR): -175.
    expect(calculateFxGainLoss(1000, 1, 1.25)).toBe(200);
    expect(calculateFxGainLoss(1000, 1.6, 1.25)).toBe(-175);
    expect(calculateFxGainLoss(1000, 1.25, 1.25)).toBe(0);
  });
});

describe('rate helpers', () => {
  it('parseRate accepts numbers above zero only', () => {
    expect(parseRate('1.25')).toBe(1.25);
    expect(parseRate(2)).toBe(2);
    expect(parseRate('0')).toBeNull();
    expect(parseRate('-1')).toBeNull();
    expect(parseRate('abc')).toBeNull();
    expect(parseRate(null)).toBeNull();
    expect(parseRate('')).toBeNull();
  });

  it('formats at the 6 decimals of the column', () => {
    expect(formatRate(1.25)).toBe('1.250000');
    expect(formatRate(1 / 3)).toBe('0.333333');
  });

  it('tells a foreign currency from the base, case-insensitively', () => {
    expect(isForeignCurrency('EUR', 'USD')).toBe(true);
    expect(isForeignCurrency('EUR', 'eur')).toBe(false);
    expect(isForeignCurrency('EUR', null)).toBe(false);
  });

  it('the typed-rate schema takes numbers and numeric strings above zero', () => {
    expect(exchangeRateSchema.parse(' 1.08 ')).toBe('1.08');
    expect(exchangeRateSchema.parse(2)).toBe('2');
    expect(exchangeRateSchema.safeParse('0').success).toBe(false);
    expect(exchangeRateSchema.safeParse('x').success).toBe(false);
    expect(exchangeRateSchema.safeParse('').success).toBe(false);
  });
});

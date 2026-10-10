import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEAL_CURRENCY,
  dealCurrencySymbol,
  dominantCurrency,
  formatCurrencyTotals,
  formatDealDate,
  formatDealMoney,
  formatDealTotals,
  fromDateInputValue,
  getCurrencyOptions,
  resolveDealCurrency,
  sumByCurrency,
  toDateInputValue,
} from './deal-format';

describe('deal-format', () => {
  it('falls back to the default currency for a missing or malformed code', () => {
    expect(resolveDealCurrency(undefined)).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('')).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('eu')).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('usd')).toBe('USD');
  });

  it("formats money in the deal's own currency, not a hardcoded dollar", () => {
    expect(formatDealMoney(1500, 'EUR')).toContain('€');
    expect(formatDealMoney(1500, 'EUR')).not.toContain('$');
    expect(formatDealMoney(1500, 'USD')).toContain('$');
    expect(formatDealMoney(1500, undefined)).toContain('€');
  });

  it('does not throw for an unknown currency code', () => {
    expect(() => formatDealMoney(10, 'ZZZ')).not.toThrow();
  });

  it('exposes the currency symbol for input adornments', () => {
    expect(dealCurrencySymbol('EUR')).toBe('€');
    expect(dealCurrencySymbol(null)).toBe('€');
  });

  it('formats close dates one way and tolerates bad input', () => {
    expect(formatDealDate('2026-10-20T12:00:00Z')).toBe('Oct 20, 2026');
    expect(formatDealDate(undefined)).toBeNull();
  });

  describe('totals', () => {
    const usd = (amount: number) => ({ amount, currency: 'USD' });

    it('keeps totals of different currencies apart instead of adding them', () => {
      const totals = sumByCurrency([usd(100), { amount: 50, currency: 'EUR' }, usd(25)]);
      expect([...totals.entries()]).toEqual([
        ['USD', 125],
        ['EUR', 50],
      ]);
      const text = formatCurrencyTotals(totals);
      expect(text).toMatch(/\$.?125|125.?\$/);
      expect(text).toMatch(/€.?50|50.?€/);
      expect(text).toContain(' + ');
    });

    it('shows an empty total in the currency of the deals around it, not a hard-coded euro', () => {
      const deals = [usd(5300), usd(12000)];
      const wonText = formatDealTotals([], { emptyCurrency: dominantCurrency(deals) });
      expect(wonText).toContain('$');
      expect(wonText).not.toContain('€');
      expect(formatDealTotals(deals, { emptyCurrency: 'EUR' })).toMatch(/17.?300/);
    });

    it('picks the most common currency, the first seen on a tie, and the fallback when empty', () => {
      expect(dominantCurrency([{ currency: 'USD' }, { currency: 'EUR' }, { currency: 'EUR' }])).toBe('EUR');
      expect(dominantCurrency([{ currency: 'USD' }, { currency: 'EUR' }])).toBe('USD');
      expect(dominantCurrency([], 'GBP')).toBe('GBP');
    });
  });

  it('offers ISO 4217 options labelled with the code', () => {
    const options = getCurrencyOptions();
    expect(options.find((o) => o.value === 'EUR')?.label).toMatch(/^EUR/);
    expect(options.some((o) => o.value === 'XYZ')).toBe(false);
  });
});

describe('close date input helpers', () => {
  it('round-trips a calendar day through the date input in local time', () => {
    const iso = fromDateInputValue('2026-11-08');
    expect(iso).not.toBeNull();
    expect(toDateInputValue(iso)).toBe('2026-11-08');
    const local = new Date(iso!);
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()]).toEqual([2026, 10, 8, 0]);
  });

  it('treats a missing or malformed value as no date', () => {
    expect(toDateInputValue(null)).toBeNull();
    expect(toDateInputValue(undefined)).toBeNull();
    expect(toDateInputValue('not a date')).toBeNull();
    expect(fromDateInputValue('')).toBeNull();
    expect(fromDateInputValue('2026-11')).toBeNull();
  });
});

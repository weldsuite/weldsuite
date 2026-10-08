import { describe, expect, it } from 'vitest';
import {
  accountFingerprint,
  addDays,
  connectionStatus,
  currencyExponent,
  decimalToMinor,
  matchPendingToPosted,
  minorToDecimalString,
  normalizeDate,
  normalizeDescription,
  plaidAmountToMinor,
  rePullWindow,
  shouldVoidPending,
  transactionFingerprint,
} from './normalize';

describe('amounts', () => {
  it('negates Plaid decimals into the statement convention', () => {
    expect(plaidAmountToMinor(12.34, 'USD')).toBe(-1234); // purchase: money out
    expect(plaidAmountToMinor(-500, 'USD')).toBe(50000); // deposit: money in
    expect(plaidAmountToMinor(0, 'USD')).toBe(0);
    expect(Object.is(plaidAmountToMinor(0, 'USD'), -0)).toBe(false);
  });

  it('rounds float noise and respects currency exponents', () => {
    expect(decimalToMinor(100.5, 'USD')).toBe(10050);
    expect(decimalToMinor(0.1 + 0.2, 'USD')).toBe(30);
    expect(decimalToMinor('19.99', 'EUR')).toBe(1999);
    expect(decimalToMinor(1200, 'JPY')).toBe(1200);
    expect(decimalToMinor('1.234', 'KWD')).toBe(1234);
    expect(currencyExponent('jpy')).toBe(0);
  });

  it('renders minor units as numeric strings', () => {
    expect(minorToDecimalString(-1234, 'USD')).toBe('-12.34');
    expect(minorToDecimalString(5, 'USD')).toBe('0.05');
    expect(minorToDecimalString(-5, 'USD')).toBe('-0.05');
    expect(minorToDecimalString(0, 'USD')).toBe('0.00');
    expect(minorToDecimalString(1200, 'JPY')).toBe('1200');
  });
});

describe('dates', () => {
  it('keeps the calendar date without time-zone conversion', () => {
    expect(normalizeDate('2026-03-31')).toBe('2026-03-31');
    expect(normalizeDate('2026-03-31T23:30:00-08:00')).toBe('2026-03-31');
    expect(normalizeDate(1_775_000_000)).toBe(new Date(1_775_000_000 * 1000).toISOString().slice(0, 10));
    expect(() => normalizeDate('not a date')).toThrow();
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('fingerprints', () => {
  it('hashes accounts deterministically and ignores casing and punctuation', async () => {
    const a = await accountFingerprint('ins_109508', '0000', 'checking');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await accountFingerprint('INS_109508', ' 0000 ', 'Checking')).toBe(a);
    expect(await accountFingerprint('ins_109508', '1111', 'checking')).not.toBe(a);
  });

  it('numbers identical lines so twins stay distinct', async () => {
    const desc = normalizeDescription('  STARBUCKS #1234 - NYC ');
    expect(desc).toBe('starbucks 1234 nyc');
    const first = await transactionFingerprint('2026-03-01', -500, desc, 0);
    const second = await transactionFingerprint('2026-03-01', -500, desc, 1);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(await transactionFingerprint('2026-03-01', -500, desc, 0)).toBe(first);
  });
});

describe('connectionStatus', () => {
  it('rolls per-account statuses up to one', () => {
    expect(connectionStatus([])).toBe('active');
    expect(connectionStatus(['active', 'active'])).toBe('active');
    expect(connectionStatus(['active', 'reauth_required'])).toBe('reauth_required');
    expect(connectionStatus(['expiring', 'active'])).toBe('expiring');
    expect(connectionStatus(['reauth_required', 'error'])).toBe('reauth_required');
  });

  it('does not let a finished account hide a live one', () => {
    expect(connectionStatus(['disconnected', 'active'])).toBe('active');
    expect(connectionStatus(['revoked', 'reauth_required'])).toBe('reauth_required');
    expect(connectionStatus(['disconnected', 'disconnected'])).toBe('disconnected');
    expect(connectionStatus(['disconnected', 'revoked'])).toBe('revoked');
  });
});

describe('date-range re-pull window', () => {
  it('pulls the full history first, then re-pulls a week back', () => {
    expect(rePullWindow({ lastThrough: null, today: '2026-10-08', historyDays: 90 })).toEqual({ from: '2026-07-10', to: '2026-10-08' });
    expect(rePullWindow({ lastThrough: '2026-10-07', today: '2026-10-08', historyDays: 90 })).toEqual({ from: '2026-09-29', to: '2026-10-08' });
  });

  it('never reaches past the provider history', () => {
    expect(rePullWindow({ lastThrough: '2026-01-01', today: '2026-10-08', historyDays: 30 }).from).toBe('2026-09-08');
  });
});

describe('pending matching for date-range providers', () => {
  const candidates = [
    { id: 'p1', accountId: 'a1', date: '2026-10-01', amountMinor: -4599, description: 'AMAZON MKTPLACE PMTS' },
    { id: 'p2', accountId: 'a1', date: '2026-10-02', amountMinor: -4599, description: 'SHELL OIL 1234' },
    { id: 'p3', accountId: 'a2', date: '2026-10-01', amountMinor: -4599, description: 'AMAZON MKTPLACE PMTS' },
  ];

  it('matches on amount, window and description', () => {
    const posted = { accountId: 'a1', date: '2026-10-04', amountMinor: -4599, description: 'Amazon Mktplace Pmts AMZN.COM/BILL' };
    expect(matchPendingToPosted(posted, candidates)?.id).toBe('p1');
  });

  it('rejects other accounts, amounts, and dates outside ten days', () => {
    expect(matchPendingToPosted({ accountId: 'a1', date: '2026-10-04', amountMinor: -100, description: 'Amazon' }, candidates)).toBeNull();
    expect(matchPendingToPosted({ accountId: 'a1', date: '2026-10-20', amountMinor: -4599, description: 'Amazon Mktplace' }, candidates)).toBeNull();
    expect(matchPendingToPosted({ accountId: 'a9', date: '2026-10-04', amountMinor: -4599, description: 'Amazon Mktplace' }, candidates)).toBeNull();
  });

  it('voids unmatched pending rows after 14 days', () => {
    expect(shouldVoidPending('2026-10-01', '2026-10-15')).toBe(false);
    expect(shouldVoidPending('2026-10-01', '2026-10-16')).toBe(true);
  });
});

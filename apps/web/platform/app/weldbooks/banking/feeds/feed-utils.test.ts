import { describe, expect, it } from 'vitest';
import {
  STATUS_BADGE_VARIANT,
  bankFeedRedirectUrl,
  canSyncNow,
  daysUntil,
  defaultBankAccountType,
  formatRelativeTime,
  historyDaysOf,
  isEnded,
  linkableBankAccounts,
  needsReauth,
  unmappedAccounts,
  type FeedBankAccount,
} from './feed-utils';
import { describeSyncOutcome } from './sync-outcome';
import { PLAID_CAPABILITIES, STRIPE_CAPABILITIES, makeAccount, makeBankAccount, makeConnection } from './test-support';
import type { BankFeedSyncOutcome } from '@/lib/api/domains/weldbooks-bank-feeds';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural } from '@weldsuite/i18n/plural';

const NOW = new Date('2026-10-08T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('speaks in the UI language, from seconds to years', () => {
    expect(formatRelativeTime('2026-10-08T11:59:50.000Z', 'en', NOW)).toBe('now');
    expect(formatRelativeTime('2026-10-08T11:55:00.000Z', 'en', NOW)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-10-08T09:00:00.000Z', 'en', NOW)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-10-07T12:00:00.000Z', 'en', NOW)).toBe('yesterday');
    expect(formatRelativeTime('2026-10-11T12:00:00.000Z', 'en', NOW)).toBe('in 3 days');
    expect(formatRelativeTime('2026-10-07T12:00:00.000Z', 'nl', NOW)).toBe('gisteren');
  });

  it('returns nothing for an invalid date', () => {
    expect(formatRelativeTime('nonsense', 'en', NOW)).toBe('');
  });
});

describe('daysUntil', () => {
  it('rounds up and goes negative once past', () => {
    expect(daysUntil('2026-10-11T00:00:00.000Z', NOW)).toBe(3);
    expect(daysUntil('2026-10-08T13:00:00.000Z', NOW)).toBe(1);
    expect(daysUntil('2026-10-07T00:00:00.000Z', NOW)).toBe(-1);
  });
});

describe('status helpers', () => {
  it('has a badge variant for every status', () => {
    expect(Object.keys(STATUS_BADGE_VARIANT).sort()).toEqual(
      ['active', 'disconnected', 'error', 'expiring', 'reauth_required', 'revoked'],
    );
  });

  it('separates statuses a sign-in repairs from those that ended', () => {
    expect(needsReauth('reauth_required')).toBe(true);
    expect(needsReauth('expiring')).toBe(true);
    expect(needsReauth('active')).toBe(false);
    expect(isEnded('revoked')).toBe(true);
    expect(isEnded('disconnected')).toBe(true);
    expect(isEnded('error')).toBe(false);
  });

  it('syncs only mapped accounts of a connection the bank still allows', () => {
    const mapped = [makeAccount({ bankAccountId: 'ba_1', bankAccountName: 'Operating' })];
    expect(canSyncNow(makeConnection({ accounts: mapped }))).toBe(true);
    expect(canSyncNow(makeConnection({ accounts: mapped, status: 'expiring' }))).toBe(true);
    expect(canSyncNow(makeConnection({ accounts: mapped, status: 'error' }))).toBe(true);
    expect(canSyncNow(makeConnection({ accounts: mapped, status: 'reauth_required' }))).toBe(false);
    expect(canSyncNow(makeConnection({ accounts: mapped, status: 'disconnected' }))).toBe(false);
    expect(canSyncNow(makeConnection({ accounts: [makeAccount()] }))).toBe(false);
  });

  it('lists the accounts still to be linked', () => {
    const connection = makeConnection({
      accounts: [makeAccount({ feedAccountId: 'a', bankAccountId: 'ba_1' }), makeAccount({ feedAccountId: 'b' })],
    });
    expect(unmappedAccounts(connection).map((a) => a.feedAccountId)).toEqual(['b']);
  });
});

describe('defaultBankAccountType', () => {
  it('follows books-api: subtype first, then the account type', () => {
    expect(defaultBankAccountType({ type: 'depository', subtype: 'savings' })).toBe('savings');
    expect(defaultBankAccountType({ type: 'depository', subtype: 'money_market' })).toBe('money_market');
    expect(defaultBankAccountType({ type: 'credit', subtype: null })).toBe('credit_card');
    expect(defaultBankAccountType({ type: 'loan', subtype: 'mortgage' })).toBe('line_of_credit');
    expect(defaultBankAccountType({ type: 'depository', subtype: 'checking' })).toBe('checking');
  });
});

describe('historyDaysOf', () => {
  it('tells Stripe Financial Connections (180) from Plaid (730)', () => {
    expect(historyDaysOf({ capabilities: PLAID_CAPABILITIES, historyDays: 730 })).toBe(730);
    expect(historyDaysOf({ capabilities: STRIPE_CAPABILITIES, historyDays: 180 })).toBe(180);
    expect(historyDaysOf({ capabilities: STRIPE_CAPABILITIES, historyDays: 730 })).toBe(180);
    expect(historyDaysOf({ capabilities: null, historyDays: 365 })).toBe(365);
    expect(historyDaysOf({ capabilities: null, historyDays: null })).toBeNull();
  });
});

describe('linkableBankAccounts', () => {
  const accounts = [
    makeBankAccount({ id: 'free' }),
    makeBankAccount({ id: 'mine', feedConnectionId: 'bkc_1', feedStatus: 'active' }),
    makeBankAccount({ id: 'other', feedConnectionId: 'bkc_2', feedStatus: 'active' }),
    makeBankAccount({ id: 'revoked', feedConnectionId: 'bkc_2', feedStatus: 'revoked' }),
    makeBankAccount({ id: 'inactive', isActive: false }),
  ] as unknown as FeedBankAccount[];

  it('leaves out bank accounts another live connection feeds, and inactive ones', () => {
    expect(linkableBankAccounts(accounts, 'bkc_1').map((a) => a.id)).toEqual(['free', 'mine', 'revoked']);
  });
});

describe('bankFeedRedirectUrl', () => {
  it('is the callback route of this origin', () => {
    expect(bankFeedRedirectUrl('https://app.weldsuite.org')).toBe(
      'https://app.weldsuite.org/weldbooks/banking/feeds/callback',
    );
  });
});

describe('describeSyncOutcome', () => {
  const t = en.weldbooksUs.bankFeeds;
  const format = interpolate;
  const pluralText = (count: number, forms: { other: string; one?: string }) => plural(count, forms, 'en');
  const outcome = (overrides: Partial<BankFeedSyncOutcome> = {}): BankFeedSyncOutcome => ({
    connectionId: 'bkc_1',
    status: 'active',
    added: 0,
    updated: 0,
    removed: 0,
    pending: 0,
    pendingVoided: 0,
    possibleDuplicates: 0,
    autoReconciled: 0,
    warnings: 0,
    ...overrides,
  });

  it('counts what changed and what matched', () => {
    expect(describeSyncOutcome(outcome({ added: 5, updated: 2, removed: 1, autoReconciled: 3 }), t, format, pluralText)).toEqual({
      kind: 'success',
      text: 'Sync finished: 5 new, 2 updated, 1 removed. 3 matched automatically.',
    });
    expect(describeSyncOutcome(outcome(), t, format, pluralText)).toEqual({ kind: 'success', text: 'Already up to date.' });
  });

  it('shows a provider error from a sync that answered 200', () => {
    expect(describeSyncOutcome(outcome({ error: 'RATE_LIMIT' }), t, format, pluralText)).toEqual({
      kind: 'error',
      text: 'The sync did not work: RATE_LIMIT',
    });
  });

  it('explains a skipped sync', () => {
    expect(describeSyncOutcome(outcome({ skipped: 'in_progress' }), t, format, pluralText).kind).toBe('info');
    expect(describeSyncOutcome(outcome({ skipped: 'not_active' }), t, format, pluralText).kind).toBe('error');
    expect(describeSyncOutcome(outcome({ skipped: 'no_mapped_accounts' }), t, format, pluralText).text).toBe(
      t.sync.noAccounts,
    );
  });
});

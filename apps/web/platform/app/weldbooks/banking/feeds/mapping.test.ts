import { describe, expect, it } from 'vitest';
import {
  buildMapAccountsInput,
  initialMappingRows,
  mappingProblems,
  suggestedBankAccountName,
  type MappingRows,
} from './mapping';
import { makeAccount, makeBankAccount } from './test-support';
import type { FeedBankAccount } from './feed-utils';

const bankAccounts = [
  makeBankAccount({ id: 'ba_op', name: 'Operating', lastImportDate: '2026-09-01T10:30:00.000Z' }),
  makeBankAccount({ id: 'ba_sv', name: 'Savings' }),
] as unknown as FeedBankAccount[];

const accounts = [
  makeAccount({
    feedAccountId: 'fa_checking',
    name: 'Business Checking',
    suggestion: { bankAccountId: 'ba_op', bankAccountName: 'Operating', reason: 'last4' },
  }),
  makeAccount({ feedAccountId: 'fa_card', name: 'Platinum Card', type: 'credit', subtype: 'credit_card' }),
  makeAccount({ feedAccountId: 'fa_sav', name: 'Rainy Day', subtype: 'savings' }),
];

describe('initialMappingRows', () => {
  it('links a suggested match, starting the feed after its last import, and creates the rest', () => {
    const rows = initialMappingRows(accounts, { institutionName: 'First Platypus Bank', bankAccounts });

    expect(rows.fa_checking).toMatchObject({ action: 'link', bankAccountId: 'ba_op', syncFrom: '2026-09-01' });
    expect(rows.fa_card).toMatchObject({
      action: 'create',
      createName: 'First Platypus Bank Platinum Card',
      createType: 'credit_card',
      syncFrom: '',
    });
    expect(rows.fa_sav).toMatchObject({ action: 'create', createType: 'savings' });
  });

  it('offers the bank account the user came from to the first account without a suggestion', () => {
    const rows = initialMappingRows(accounts, {
      institutionName: null,
      bankAccounts,
      defaultBankAccountId: 'ba_sv',
    });
    expect(rows.fa_card).toMatchObject({ action: 'link', bankAccountId: 'ba_sv' });
    expect(rows.fa_sav.action).toBe('create');
  });

  it('does not offer the originating bank account when a suggestion already uses it', () => {
    const rows = initialMappingRows(accounts, { institutionName: null, bankAccounts, defaultBankAccountId: 'ba_op' });
    expect(rows.fa_checking.bankAccountId).toBe('ba_op');
    expect(rows.fa_card.action).toBe('create');
  });
});

describe('suggestedBankAccountName', () => {
  it('leads with the bank unless the name already names it', () => {
    expect(suggestedBankAccountName({ name: 'Checking' }, 'Chase')).toBe('Chase Checking');
    expect(suggestedBankAccountName({ name: 'Chase Checking' }, 'chase')).toBe('Chase Checking');
    expect(suggestedBankAccountName({ name: 'Checking' }, null)).toBe('Checking');
  });
});

describe('buildMapAccountsInput', () => {
  const rows: MappingRows = {
    fa_checking: { action: 'link', bankAccountId: 'ba_op', createName: '', createType: 'checking', syncFrom: '2026-09-01' },
    fa_card: { action: 'create', bankAccountId: '', createName: '  Amex Gold ', createType: 'credit_card', syncFrom: '' },
    fa_sav: { action: 'skip', bankAccountId: '', createName: 'x', createType: 'savings', syncFrom: '2026-01-01' },
  };

  it('builds link, create and skip into the map-accounts body', () => {
    expect(buildMapAccountsInput(accounts, rows, { sync: true })).toEqual({
      mappings: [
        { feedAccountId: 'fa_checking', bankAccountId: 'ba_op', syncFrom: '2026-09-01' },
        // An empty start date reads as far back as the provider allows: null, not the empty string.
        { feedAccountId: 'fa_card', create: { name: 'Amex Gold', accountType: 'credit_card' }, syncFrom: null },
      ],
      sync: true,
    });
  });

  it('passes the choice to start the first sync', () => {
    expect(buildMapAccountsInput(accounts, rows, { sync: false })?.sync).toBe(false);
  });

  it('returns null when every account is skipped', () => {
    const skipped = Object.fromEntries(
      Object.entries(rows).map(([id, row]) => [id, { ...row, action: 'skip' as const }]),
    );
    expect(buildMapAccountsInput(accounts, skipped, { sync: true })).toBeNull();
  });
});

describe('mappingProblems', () => {
  it('flags a missing bank account, a bank account used twice and an empty name', () => {
    const rows: MappingRows = {
      fa_checking: { action: 'link', bankAccountId: 'ba_op', createName: '', createType: 'checking', syncFrom: '' },
      fa_card: { action: 'link', bankAccountId: 'ba_op', createName: '', createType: 'checking', syncFrom: '' },
      fa_sav: { action: 'create', bankAccountId: '', createName: '   ', createType: 'savings', syncFrom: '' },
    };
    expect(mappingProblems(accounts, rows)).toEqual({
      fa_card: 'bank_account_twice',
      fa_sav: 'name_required',
    });
    expect(
      mappingProblems(accounts, { ...rows, fa_card: { ...rows.fa_card, bankAccountId: '' } }).fa_card,
    ).toBe('bank_account_required');
  });

  it('has no problems for skipped accounts', () => {
    const rows: MappingRows = Object.fromEntries(
      accounts.map((a) => [a.feedAccountId, { action: 'skip' as const, bankAccountId: '', createName: '', createType: 'checking' as const, syncFrom: '' }]),
    );
    expect(mappingProblems(accounts, rows)).toEqual({});
  });
});

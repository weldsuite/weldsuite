/**
 * The account-mapping step after a link: each feed account is linked to an
 * existing WeldBooks bank account, created as a new one, or skipped. This file
 * holds the state and the payload for `POST /bank-connections/:id/map-accounts`,
 * so the dialog stays a thin shell and the payload is testable on its own.
 */
import type {
  BankFeedAccount,
  BankFeedAccountMapping,
  BankFeedBankAccountType,
  BankFeedMapAccountsInput,
} from '@/lib/api/domains/weldbooks-bank-feeds';
import { toCalendarDate } from '@/lib/weldbooks/format';
import { defaultBankAccountType, type FeedBankAccount } from './feed-utils';

export type MappingAction = 'link' | 'create' | 'skip';

export interface MappingRow {
  action: MappingAction;
  /** Link: the WeldBooks bank account. */
  bankAccountId: string;
  /** Create: name and type of the new bank account. */
  createName: string;
  createType: BankFeedBankAccountType;
  /** `YYYY-MM-DD`; empty imports as far back as the provider allows. */
  syncFrom: string;
}

export type MappingRows = Record<string, MappingRow>;

export type MappingProblem = 'bank_account_required' | 'bank_account_twice' | 'name_required';

/** A name for a new bank account: the feed account's name, led by the bank when the name does not already say which bank. */
export function suggestedBankAccountName(account: Pick<BankFeedAccount, 'name'>, institutionName: string | null): string {
  const name = account.name.trim();
  const bank = institutionName?.trim();
  if (!bank || name.toLowerCase().includes(bank.toLowerCase())) return name;
  return `${bank} ${name}`;
}

/** The day the account's last statement import ran, as a date; the default start of its feed. */
export function lastImportDay(account: Pick<FeedBankAccount, 'lastImportDate'> | undefined): string {
  return toCalendarDate(account?.lastImportDate ?? null) ?? '';
}

export interface InitialMappingOptions {
  institutionName: string | null;
  bankAccounts: FeedBankAccount[];
  /** Bank account the user came from (the bank account page): offered to the first account without a better match. */
  defaultBankAccountId?: string;
}

/**
 * Starting point of the dialog: a suggested match is linked, the bank account
 * the user came from is linked to the first account without a suggestion, and
 * everything else is created new. The feed starts after an existing bank
 * account's last import, so imported statements are not imported twice.
 */
export function initialMappingRows(accounts: BankFeedAccount[], options: InitialMappingOptions): MappingRows {
  const rows: MappingRows = {};
  const byId = new Map(options.bankAccounts.map((a) => [a.id, a]));
  const taken = new Set<string>();
  for (const account of accounts) {
    if (account.suggestion?.bankAccountId) taken.add(account.suggestion.bankAccountId);
  }
  let defaultAvailable = !!options.defaultBankAccountId && !taken.has(options.defaultBankAccountId);

  for (const account of accounts) {
    let bankAccountId = account.suggestion?.bankAccountId ?? '';
    if (!bankAccountId && defaultAvailable && options.defaultBankAccountId) {
      bankAccountId = options.defaultBankAccountId;
      defaultAvailable = false;
    }
    rows[account.feedAccountId] = {
      action: bankAccountId ? 'link' : 'create',
      bankAccountId,
      createName: suggestedBankAccountName(account, options.institutionName),
      createType: defaultBankAccountType(account),
      syncFrom: bankAccountId ? lastImportDay(byId.get(bankAccountId)) : '',
    };
  }
  return rows;
}

/** Problems that keep the dialog from submitting, per feed account. */
export function mappingProblems(accounts: BankFeedAccount[], rows: MappingRows): Record<string, MappingProblem> {
  const problems: Record<string, MappingProblem> = {};
  const seen = new Set<string>();
  for (const account of accounts) {
    const row = rows[account.feedAccountId];
    if (!row || row.action === 'skip') continue;
    if (row.action === 'link') {
      if (!row.bankAccountId) problems[account.feedAccountId] = 'bank_account_required';
      else if (seen.has(row.bankAccountId)) problems[account.feedAccountId] = 'bank_account_twice';
      else seen.add(row.bankAccountId);
    } else if (!row.createName.trim()) {
      problems[account.feedAccountId] = 'name_required';
    }
  }
  return problems;
}

/**
 * The `map-accounts` body, or null when nothing is to be linked. Skipped
 * accounts are left out (they stay unmapped); an empty start date is sent as
 * `null`, which reads as far back as the provider allows.
 */
export function buildMapAccountsInput(
  accounts: BankFeedAccount[],
  rows: MappingRows,
  options: { sync: boolean },
): BankFeedMapAccountsInput | null {
  const mappings: BankFeedAccountMapping[] = [];
  for (const account of accounts) {
    const row = rows[account.feedAccountId];
    if (!row || row.action === 'skip') continue;
    const syncFrom = row.syncFrom.trim() || null;
    if (row.action === 'link') {
      mappings.push({ feedAccountId: account.feedAccountId, bankAccountId: row.bankAccountId, syncFrom });
    } else {
      mappings.push({
        feedAccountId: account.feedAccountId,
        create: { name: row.createName.trim(), accountType: row.createType },
        syncFrom,
      });
    }
  }
  return mappings.length > 0 ? { mappings, sync: options.sync } : null;
}

/**
 * Bank account details beyond the name: US routing and account numbers, the
 * account type, and the ledger account behind it.
 *
 * The full account number is stored encrypted (`accountNumberEncrypted`) with
 * only its last four digits in the clear; the encrypted value never leaves
 * the worker except through `revealAccountNumber`, which writes the reveal
 * log first.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { decryptField, encryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { accountForRole, loadEntityAccounts, PostingError } from './accounting-posting';

export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'money_market', 'line_of_credit'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

/** Credit cards and lines of credit are liabilities: a charge increases what is owed. */
export function isLiabilityAccountType(type: string | null | undefined): boolean {
  return type === 'credit_card' || type === 'line_of_credit';
}

/** ABA routing number check: nine digits, weights 3-7-1, sum divisible by 10. */
export function isValidAbaRouting(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...value].reduce((total, digit, i) => total + Number(digit) * weights[i], 0);
  return sum % 10 === 0;
}

/** Account numbers as people type them: spaces and dashes dropped, 4 to 34 letters or digits. */
export function normalizeAccountNumber(value: string): string | null {
  const cleaned = value.replaceAll(/[\s-]/g, '');
  return /^[0-9A-Za-z*]{4,34}$/.test(cleaned) ? cleaned : null;
}

export function lastFour(accountNumber: string): string {
  return accountNumber.slice(-4);
}

/** Keys of `bank_accounts` that must not reach a response, an event or a log. */
const SENSITIVE_COLUMNS = ['accountNumberEncrypted'] as const;

/** A bank account row for API responses and events: no encrypted number, a flag saying one is stored. */
export function publicBankAccount<T extends Partial<BankAccountRow>>(
  row: T,
): Omit<T, (typeof SENSITIVE_COLUMNS)[number]> & { hasAccountNumber: boolean } {
  const { accountNumberEncrypted, ...rest } = row;
  return { ...rest, hasAccountNumber: Boolean(accountNumberEncrypted) };
}

export class AccountNumberKeyError extends Error {
  constructor() {
    super('Account numbers cannot be stored: the worker has no encryption key');
    this.name = 'AccountNumberKeyError';
  }
}

function requireKeyring(env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string }): EncryptionKeyring {
  const keyring = keyringFromEnv(env);
  if (!keyring.v1 && !keyring.v2) throw new AccountNumberKeyError();
  return keyring;
}

export async function sealAccountNumber(
  env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string },
  accountNumber: string,
): Promise<{ accountNumberEncrypted: string; accountNumberLast4: string }> {
  const keyring = requireKeyring(env);
  return {
    accountNumberEncrypted: await encryptField(accountNumber, keyring),
    accountNumberLast4: lastFour(accountNumber),
  };
}

/**
 * Decrypt a bank account's number for an authorized reveal. The reveal is
 * logged before the number is returned, and a failed log write refuses the
 * reveal.
 */
export async function revealAccountNumber(
  db: Database,
  env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string },
  args: { account: BankAccountRow; userId: string; reason?: string | null },
): Promise<{ accountNumber: string; routingNumber: string | null }> {
  const { account } = args;
  if (!account.accountNumberEncrypted) throw new PostingError('This bank account has no account number on file');
  const keyring = requireKeyring(env);

  await db.insert(schema.taxIdReveals).values({
    id: generateId('tir'),
    entityId: account.entityId,
    subjectType: 'bank_account',
    subjectId: account.id,
    field: 'account_number',
    revealedBy: args.userId,
    reason: args.reason?.slice(0, 255) ?? null,
  });
  const accountNumber = await decryptField(account.accountNumberEncrypted, keyring);
  return { accountNumber, routingNumber: account.routingNumber ?? null };
}

// ── Ledger account behind a bank account ────────────────────────────────────

function numericCode(code: string): number | null {
  return /^\d+$/.test(code) ? Number.parseInt(code, 10) : null;
}

/** The first unused numeric code above `start`, so a new account never collides with the chart. */
function nextFreeCode(taken: Set<string>, start: number): string {
  let candidate = start;
  while (taken.has(String(candidate))) candidate += 1;
  return String(candidate);
}

/**
 * Check a chosen ledger account suits the account type: cards and lines of
 * credit sit on a liability account, everything else on an asset.
 */
export function assertLedgerAccountFits(ledger: AccountRow, accountType: string | null | undefined): void {
  if (!accountType) return;
  const wanted = isLiabilityAccountType(accountType) ? 'liability' : 'asset';
  if (ledger.type !== wanted) {
    throw new PostingError(
      `A ${accountType.replaceAll('_', ' ')} account needs a ${wanted} ledger account, but ${ledger.code} ${ledger.name} is ${ledger.type === 'asset' ? 'an asset' : `a ${ledger.type}`} account.`,
    );
  }
}

/** Chart accounts a new bank account of this type may take over when nothing links to them yet ("Checking", "Savings"). */
const REUSABLE_NAMES: Record<BankAccountType, RegExp | null> = {
  checking: /check/i,
  savings: /saving/i,
  money_market: /money market/i,
  line_of_credit: /line of credit/i,
  credit_card: null,
};

export type BankLedgerPlan =
  | { kind: 'existing'; account: AccountRow }
  | { kind: 'new'; row: typeof schema.accounts.$inferInsert };

/**
 * Which ledger account a new bank account of this type sits on. A chart that
 * ships a matching, still unlinked account ("1000 Checking", "2500 Line of
 * credit") is reused, so setting up the first bank account doesn't leave an
 * orphan next to it. Otherwise a new account: a child of Credit Card Payable
 * for a card (cards get one each, so each reconciles on its own), a liability
 * for a line of credit, an asset bank account for the rest. A new account
 * carries the income-tax line of its neighbours (`bs_cash`, `sch_c.bs`).
 */
export async function planBankLedgerAccount(
  db: Database,
  args: { entityId: string; name: string; accountType: BankAccountType; currency: string },
): Promise<BankLedgerPlan> {
  const [chart, linked] = await Promise.all([
    db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.entityId, args.entityId), isNull(schema.accounts.deletedAt))),
    db
      .select({ ledgerAccountId: schema.bankAccounts.ledgerAccountId })
      .from(schema.bankAccounts)
      .where(and(eq(schema.bankAccounts.entityId, args.entityId), isNull(schema.bankAccounts.deletedAt))),
  ]);
  const linkedIds = new Set(linked.map((l) => l.ledgerAccountId).filter((id): id is string => Boolean(id)));
  const liability = isLiabilityAccountType(args.accountType);

  const reusable = REUSABLE_NAMES[args.accountType];
  const existing = reusable
    ? [...chart]
        .sort((a, b) => a.code.localeCompare(b.code))
        .find(
          (a) =>
            a.isActive !== false &&
            !linkedIds.has(a.id) &&
            a.type === (liability ? 'liability' : 'asset') &&
            (liability ? true : a.subtype === 'bank') &&
            reusable.test(a.name) &&
            !chart.some((child) => child.parentAccountId === a.id),
        )
    : undefined;
  if (existing) return { kind: 'existing', account: existing };

  const accounts = await loadEntityAccounts(db, args.entityId);
  const parent = args.accountType === 'credit_card' ? accountForRole(accounts, 'credit_card_payable') : undefined;
  const subtype = liability ? args.accountType : 'bank';
  const sibling = parent ?? chart.find((a) => a.subtype === subtype && a.type === (liability ? 'liability' : 'asset') && a.taxLine);

  let startCode: number;
  if (parent && numericCode(parent.code) !== null) {
    startCode = numericCode(parent.code)! + 1;
  } else {
    const sameKind = chart
      .filter((r) => (liability ? r.type === 'liability' : r.type === 'asset' && (r.subtype === 'bank' || r.subtype === 'cash')))
      .map((r) => numericCode(r.code))
      .filter((n): n is number => n !== null);
    startCode = sameKind.length > 0 ? Math.max(...sameKind) + 1 : liability ? 2000 : 1000;
  }

  const now = new Date();
  return {
    kind: 'new',
    row: {
      id: generateId('acc'),
      entityId: args.entityId,
      code: nextFreeCode(new Set(chart.map((r) => r.code)), startCode),
      name: args.name,
      type: liability ? 'liability' : 'asset',
      subtype,
      normalSide: liability ? 'credit' : 'debit',
      parentAccountId: parent?.id ?? null,
      currency: args.currency,
      taxLine: sibling?.taxLine ?? null,
      isActive: true,
      isSystemAccount: false,
      currentBalance: '0',
      createdAt: now,
      updatedAt: now,
    },
  };
}

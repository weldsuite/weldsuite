/**
 * Ledger account for a bank account created from a feed account. Checking and
 * savings sit with the entity's other bank accounts (assets, `1000s`); a credit
 * card or line of credit goes under the credit card payable liability when the
 * chart has one.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export type BankAccountType = 'checking' | 'savings' | 'credit_card' | 'money_market' | 'line_of_credit';

export function isLiabilityAccountType(accountType: BankAccountType): boolean {
  return accountType === 'credit_card' || accountType === 'line_of_credit';
}

function numericCode(code: string): number | null {
  return /^\d+$/.test(code) ? Number(code) : null;
}

function nextFreeCode(taken: Set<string>, start: number): string {
  let candidate = start;
  while (taken.has(String(candidate))) candidate += 1;
  return String(candidate);
}

export async function createLedgerAccountForBank(
  db: Database,
  args: { entityId: string; name: string; accountType: BankAccountType; currency: string },
): Promise<string> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, args.entityId), isNull(schema.accounts.deletedAt)));
  const taken = new Set(rows.map((a) => a.code));
  const liability = isLiabilityAccountType(args.accountType);

  let parentId: string | null = null;
  let start: number;
  if (liability) {
    const parent =
      rows.find((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === 'credit_card_payable') ??
      rows.find((a) => a.type === 'liability' && a.subtype === 'credit_card');
    parentId = parent?.id ?? null;
    const siblings = rows.filter((a) => a.type === 'liability' && (a.subtype === 'credit_card' || a.parentAccountId === parent?.id));
    const codes = siblings.map((a) => numericCode(a.code)).filter((n): n is number => n !== null);
    start = codes.length > 0 ? Math.max(...codes) + 1 : 2150;
  } else {
    const bank = rows.filter((a) => a.type === 'asset' && a.subtype === 'bank');
    const codes = bank.map((a) => numericCode(a.code)).filter((n): n is number => n !== null);
    start = codes.length > 0 ? Math.max(...codes) + 1 : 1000;
  }

  const id = generateId('acc');
  const now = new Date();
  await db.insert(schema.accounts).values({
    id,
    entityId: args.entityId,
    code: nextFreeCode(taken, start),
    name: args.name,
    type: liability ? 'liability' : 'asset',
    subtype: liability ? 'credit_card' : 'bank',
    parentAccountId: parentId,
    currency: args.currency,
    isActive: true,
    isSystemAccount: false,
    openingBalance: '0',
    currentBalance: '0',
    normalSide: liability ? 'credit' : 'debit',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

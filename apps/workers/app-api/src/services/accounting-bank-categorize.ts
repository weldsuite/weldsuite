/**
 * Post a bank statement line to the general ledger without an invoice or bill.
 *
 * Used for money that is not a customer payment or supplier bill: fee refunds,
 * payment-processor settlements, interest, owner deposits, bank charges.
 *
 * Journal:
 *   money in  →  Dr bank ledger   /   Cr category (e.g. Other income, Bank fees)
 *   money out →  Dr category      /   Cr bank ledger
 *
 * The bank account's cashbook balance is already updated on import/create.
 * This only posts the GL so P&L and the balance sheet stay in sync.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { nextEntityNumber, resolveEntityBaseCurrency } from '../lib/entity-context';
import { assertPeriodOpen } from './accounting-guards';

export class BankCategorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankCategorizeError';
  }
}

export interface CategorizeBankTransactionInput {
  txn: typeof schema.bankTransactions.$inferSelect;
  categoryAccountId: string;
  contactId?: string | null;
  userId: string | null;
}

export interface CategorizeBankTransactionResult {
  journalEntryId: string;
  entryNumber: string;
}

async function applyLineBalances(
  db: Database,
  lines: Array<{ accountId: string; debit: string; credit: string }>,
): Promise<void> {
  const { accounts } = schema;
  for (const line of lines) {
    const debit = parseFloat(line.debit || '0');
    const credit = parseFloat(line.credit || '0');
    const netChange = debit - credit;
    if (netChange !== 0) {
      await db
        .update(accounts)
        .set({
          currentBalance: sql`(${accounts.currentBalance}::numeric + ${netChange})`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, line.accountId));
    }
  }
}

export async function categorizeBankTransaction(
  db: Database,
  args: CategorizeBankTransactionInput,
): Promise<CategorizeBankTransactionResult> {
  const { txn, categoryAccountId, contactId, userId } = args;
  const { bankAccounts, bankTransactions, accounts, journalEntries, journalLines } = schema;

  if (txn.status !== 'unreconciled') {
    throw new BankCategorizeError('Transaction is already reconciled or excluded');
  }
  if (txn.journalEntryId) {
    throw new BankCategorizeError('Transaction already has a journal entry');
  }

  const abs = Math.abs(Number(txn.amount));
  if (!Number.isFinite(abs) || abs === 0) {
    throw new BankCategorizeError('Transaction amount must be non-zero');
  }
  const amount = abs.toFixed(2);
  const moneyIn = Number(txn.amount) > 0;

  const [bankAccount] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, txn.bankAccountId), isNull(bankAccounts.deletedAt)))
    .limit(1);
  if (!bankAccount) {
    throw new BankCategorizeError('Bank account not found');
  }
  if (!bankAccount.ledgerAccountId) {
    throw new BankCategorizeError(
      'This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.',
    );
  }

  const [category] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, categoryAccountId),
        eq(accounts.entityId, txn.entityId),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!category) {
    throw new BankCategorizeError('Category account not found');
  }
  if (category.id === bankAccount.ledgerAccountId) {
    throw new BankCategorizeError('Pick an income or expense account, not the bank ledger account itself');
  }

  const [ledger] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, bankAccount.ledgerAccountId),
        eq(accounts.entityId, txn.entityId),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!ledger) {
    throw new BankCategorizeError('Linked ledger account was not found');
  }

  await assertPeriodOpen(db, txn.entityId, txn.date);

  const { formatted: entryNumber } = await nextEntityNumber(db, txn.entityId, 'journal');
  const journalEntryId = generateId('je');
  const now = new Date();
  const currency = bankAccount.currency || (await resolveEntityBaseCurrency(db, txn.entityId));
  const counterparty = txn.counterpartyName ? ` — ${txn.counterpartyName}` : '';
  const description = txn.description
    ? `Bank: ${txn.description}${counterparty}`
    : moneyIn
      ? `Bank receipt${counterparty}`
      : `Bank payment${counterparty}`;

  const bankDebit = moneyIn ? amount : '0.00';
  const bankCredit = moneyIn ? '0.00' : amount;
  const categoryDebit = moneyIn ? '0.00' : amount;
  const categoryCredit = moneyIn ? amount : '0.00';

  await db.insert(journalEntries).values({
    id: journalEntryId,
    entityId: txn.entityId,
    entryNumber,
    date: txn.date,
    status: 'posted',
    description,
    reference: txn.reference || null,
    sourceType: 'bank_transaction',
    sourceId: txn.id,
    totalDebit: amount,
    totalCredit: amount,
    isAutomatic: true,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(journalLines).values([
    {
      id: generateId('jl'),
      entityId: txn.entityId,
      journalEntryId,
      accountId: ledger.id,
      description,
      debit: bankDebit,
      credit: bankCredit,
      contactId: contactId || txn.contactId || null,
      currency,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId('jl'),
      entityId: txn.entityId,
      journalEntryId,
      accountId: category.id,
      description,
      debit: categoryDebit,
      credit: categoryCredit,
      contactId: contactId || txn.contactId || null,
      currency,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await applyLineBalances(db, [
    { accountId: ledger.id, debit: bankDebit, credit: bankCredit },
    { accountId: category.id, debit: categoryDebit, credit: categoryCredit },
  ]);

  await db
    .update(bankTransactions)
    .set({
      status: 'reconciled',
      reconciliationType: 'manual',
      categoryAccountId,
      journalEntryId,
      contactId: contactId || txn.contactId || null,
      updatedAt: now,
    })
    .where(eq(bankTransactions.id, txn.id));

  return { journalEntryId, entryNumber };
}

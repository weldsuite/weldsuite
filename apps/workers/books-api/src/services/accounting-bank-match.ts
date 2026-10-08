/**
 * Matching a bank statement line to an invoice or bill, and undoing a match.
 *
 * A match is a payment: money in against an invoice, money out against a
 * bill. It records and posts the payment through `recordPayment` (Dr bank /
 * Cr receivable, or Dr payable / Cr bank), settles the document and marks the
 * line reconciled, all in one atomic posting. Undoing voids that payment, or
 * reverses the categorization entry for a line posted straight to an account.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { PostingError, reverseJournalEntry, roundMoney } from './accounting-posting';
import { recordPayment, voidPayment } from './accounting-payments';

type BankTransactionRow = typeof schema.bankTransactions.$inferSelect;

export async function reconcileBankTransactionToDocument(
  db: Database,
  args: {
    txn: BankTransactionRow;
    type: 'invoice' | 'bill';
    documentId: string;
    reconciliationType?: 'manual' | 'auto';
    userId: string | null;
  },
): Promise<{ paymentId: string; journalEntryId: string | null }> {
  const { txn } = args;
  if (txn.status !== 'unreconciled') throw new PostingError('Transaction is already reconciled or excluded');

  const amount = Number.parseFloat(txn.amount ?? '0');
  if (args.type === 'invoice' && !(amount > 0)) {
    throw new PostingError('Only money coming in can be matched to an invoice');
  }
  if (args.type === 'bill' && !(amount < 0)) {
    throw new PostingError('Only money going out can be matched to a bill');
  }

  const table = args.type === 'invoice' ? schema.invoices : schema.bills;
  const [doc] = await db
    .select({ id: table.id, entityId: table.entityId, contactId: table.contactId, balanceDue: table.balanceDue })
    .from(table)
    .where(and(eq(table.id, args.documentId), isNull(table.deletedAt)))
    .limit(1);
  if (!doc) throw new PostingError(`${args.type === 'invoice' ? 'Invoice' : 'Bill'} not found`);
  if (doc.entityId !== txn.entityId) throw new PostingError(`Linked ${args.type} belongs to a different accounting entity`);

  const [bankAccount] = await db
    .select({ currency: schema.bankAccounts.currency })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.id, txn.bankAccountId))
    .limit(1);

  const paid = roundMoney(Math.abs(amount));
  // Anything above the open balance stays on the contact as an unapplied credit.
  const allocated = roundMoney(Math.min(paid, Number.parseFloat(doc.balanceDue ?? '0')));

  const result = await recordPayment(db, {
    entityId: txn.entityId,
    type: args.type === 'invoice' ? 'received' : 'sent',
    amount: paid,
    currency: bankAccount?.currency ?? null,
    date: txn.date,
    paymentMethod: 'bank_transfer',
    reference: txn.reference ?? txn.endToEndId ?? txn.description ?? null,
    contactId: doc.contactId,
    bankAccountId: txn.bankAccountId,
    bankTransactionId: txn.id,
    reconciliationType: args.reconciliationType ?? 'manual',
    allocations:
      allocated > 0
        ? [{ [args.type === 'invoice' ? 'invoiceId' : 'billId']: doc.id, amount: allocated }]
        : [],
    userId: args.userId,
  });
  return { paymentId: result.paymentId, journalEntryId: result.journalEntryId };
}

/**
 * Put a reconciled line back to unreconciled: void the payment it created, or
 * reverse the entry that posted it to a category account. Excluded lines are
 * simply included again.
 */
export async function unreconcileBankTransaction(
  db: Database,
  args: { txn: BankTransactionRow; userId: string | null },
): Promise<void> {
  const { txn } = args;
  const now = new Date();
  if (txn.status === 'unreconciled') throw new PostingError('Transaction is not reconciled');

  if (txn.reconciledPaymentId) {
    await voidPayment(db, txn.reconciledPaymentId, { userId: args.userId, date: now });
    return;
  }

  const reset = {
    status: 'unreconciled',
    reconciliationType: null,
    reconciledInvoiceId: null,
    reconciledBillId: null,
    reconciledPaymentId: null,
    journalEntryId: null,
    categoryAccountId: null,
    updatedAt: now,
  };
  if (txn.journalEntryId) {
    await reverseJournalEntry(db, {
      entryId: txn.journalEntryId,
      date: now,
      createdBy: args.userId,
      description: `Undo bank line ${txn.description ?? txn.id}`,
      alsoWrite: (h) => [h.update(schema.bankTransactions).set(reset).where(eq(schema.bankTransactions.id, txn.id))],
    });
    return;
  }
  // Excluded, or matched before matches were posted: nothing in the ledger to undo.
  await atomically(db, (h) => [h.update(schema.bankTransactions).set(reset).where(eq(schema.bankTransactions.id, txn.id))]);
}

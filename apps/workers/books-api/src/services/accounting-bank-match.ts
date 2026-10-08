/**
 * Matching a bank statement line to an invoice, bill, payment or deposit, and
 * undoing a match.
 *
 * A match to an invoice or bill is a new payment: money in against an invoice,
 * money out against a bill. It records and posts the payment through
 * `recordPayment` (Dr bank / Cr receivable, or Dr payable / Cr bank), settles
 * the document and marks the line reconciled, all in one atomic posting.
 *
 * A match to a payment that already exists (a check that was written and now
 * clears, a payment entered by hand before the line arrived) or to a bank
 * deposit only links the two; the ledger already holds the money, so nothing
 * is posted. Undoing a match voids the payment it created, reverses the
 * categorization entry for a line posted straight to an account, or just
 * unlinks a payment or deposit.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { PostingError, reverseJournalEntry, roundMoney } from './accounting-posting';
import { paymentNetAmount, recordPayment, voidPayment } from './accounting-payments';

type BankTransactionRow = typeof schema.bankTransactions.$inferSelect;

/** `reconciliation_type` of a line linked to a payment recorded earlier / to a bank deposit. */
export const PAYMENT_LINK = 'payment_link';
export const DEPOSIT_LINK = 'deposit';

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
    paymentMethod: txn.checkNumber ? 'check' : 'bank_transfer',
    checkNumber: txn.checkNumber ?? null,
    // The line is the bank's proof that the money moved: a check paid this way has already cleared.
    checkStatus: args.type === 'bill' && txn.checkNumber ? 'cleared' : null,
    reference: txn.reference ?? txn.endToEndId ?? txn.description ?? null,
    contactId: doc.contactId,
    bankAccountId: txn.bankAccountId,
    bankTransactionId: txn.id,
    depositTo: 'bank',
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
 * Tie a bank line to a payment that was recorded before the line arrived. The
 * payment already debited or credited the bank's ledger account, so this only
 * links them; a check that was printed becomes cleared. The line is compared
 * with what the payment moved through the bank: its amount less any backup
 * withholding.
 */
export async function reconcileBankTransactionToPayment(
  db: Database,
  args: { txn: BankTransactionRow; paymentId: string; reconciliationType?: 'manual' | 'auto'; userId: string | null },
): Promise<{ paymentId: string; journalEntryId: string | null }> {
  const { txn } = args;
  if (txn.status !== 'unreconciled') throw new PostingError('Transaction is already reconciled or excluded');

  const [payment] = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, args.paymentId), isNull(schema.payments.deletedAt)))
    .limit(1);
  if (!payment) throw new PostingError('Payment not found');
  if (payment.entityId !== txn.entityId) throw new PostingError('The payment belongs to a different accounting entity');
  if (payment.bankTransactionId) throw new PostingError('This payment is already matched to a bank line');
  if (payment.depositId) {
    throw new PostingError('This payment is part of a bank deposit. Match the deposit to the bank line instead.');
  }

  const amount = Number.parseFloat(txn.amount ?? '0');
  if (payment.type === 'received' ? !(amount > 0) : !(amount < 0)) {
    throw new PostingError(
      payment.type === 'received'
        ? 'Only money coming in can be matched to a payment received'
        : 'Only money going out can be matched to a payment sent',
    );
  }
  // A payment with backup withholding hits the bank for its net: the withheld part never leaves the account.
  const bankAmount = paymentNetAmount(payment);
  if (Math.abs(roundMoney(Math.abs(amount)) - bankAmount) >= 0.005) {
    const withheld = Number.parseFloat(payment.backupWithholdingAmount ?? '0');
    throw new PostingError(
      withheld > 0
        ? `The payment is for ${bankAmount.toFixed(2)} (${Number.parseFloat(payment.amount).toFixed(2)} less ${withheld.toFixed(2)} backup withholding) but the bank line is ${Math.abs(amount).toFixed(2)}.`
        : `The payment is for ${bankAmount.toFixed(2)} but the bank line is ${Math.abs(amount).toFixed(2)}.`,
    );
  }

  const now = new Date();
  const clearsCheck = payment.paymentMethod === 'check' && payment.checkStatus === 'printed';
  await atomically(db, (h) => [
    h
      .update(schema.bankTransactions)
      .set({
        status: 'reconciled',
        reconciliationType: PAYMENT_LINK,
        reconciledPaymentId: payment.id,
        reconciledInvoiceId: payment.invoiceId ?? null,
        reconciledBillId: payment.billId ?? null,
        journalEntryId: payment.journalEntryId ?? null,
        contactId: payment.contactId,
        updatedAt: now,
      })
      .where(and(eq(schema.bankTransactions.id, txn.id), eq(schema.bankTransactions.status, 'unreconciled'))),
    h
      .update(schema.payments)
      .set({
        bankTransactionId: txn.id,
        ...(clearsCheck ? { checkStatus: 'cleared' } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.payments.id, payment.id), isNull(schema.payments.bankTransactionId))),
  ]);
  return { paymentId: payment.id, journalEntryId: payment.journalEntryId ?? null };
}

/**
 * Tie an incoming bank line to a bank deposit: the single line the bank shows
 * for the checks and cash that were grouped into the deposit.
 */
export async function reconcileBankTransactionToDeposit(
  db: Database,
  args: { txn: BankTransactionRow; depositId: string; userId: string | null },
): Promise<{ depositId: string; journalEntryId: string | null }> {
  const { txn } = args;
  if (txn.status !== 'unreconciled') throw new PostingError('Transaction is already reconciled or excluded');
  const amount = Number.parseFloat(txn.amount ?? '0');
  if (!(amount > 0)) throw new PostingError('Only money coming in can be matched to a deposit');

  const [deposit] = await db
    .select()
    .from(schema.bankDeposits)
    .where(and(eq(schema.bankDeposits.id, args.depositId), isNull(schema.bankDeposits.deletedAt)))
    .limit(1);
  if (!deposit) throw new PostingError('Deposit not found');
  if (deposit.entityId !== txn.entityId) throw new PostingError('The deposit belongs to a different accounting entity');
  if (deposit.status !== 'posted') throw new PostingError('This deposit has been voided');
  if (deposit.bankTransactionId) throw new PostingError('This deposit is already matched to a bank line');
  if (deposit.bankAccountId !== txn.bankAccountId) {
    throw new PostingError('The deposit was made to a different bank account than the bank line');
  }
  if (Math.abs(roundMoney(amount) - roundMoney(Number.parseFloat(deposit.amount))) >= 0.005) {
    throw new PostingError(
      `The deposit is for ${Number.parseFloat(deposit.amount).toFixed(2)} but the bank line is ${amount.toFixed(2)}.`,
    );
  }

  const now = new Date();
  await atomically(db, (h) => [
    h
      .update(schema.bankTransactions)
      .set({
        status: 'reconciled',
        reconciliationType: DEPOSIT_LINK,
        depositId: deposit.id,
        journalEntryId: deposit.journalEntryId ?? null,
        updatedAt: now,
      })
      .where(and(eq(schema.bankTransactions.id, txn.id), eq(schema.bankTransactions.status, 'unreconciled'))),
    h
      .update(schema.bankDeposits)
      .set({ bankTransactionId: txn.id, updatedAt: now })
      .where(and(eq(schema.bankDeposits.id, deposit.id), isNull(schema.bankDeposits.bankTransactionId))),
  ]);
  return { depositId: deposit.id, journalEntryId: deposit.journalEntryId ?? null };
}

/**
 * Put a reconciled line back to unreconciled: void the payment it created,
 * reverse the entry that posted it to a category account, or unlink the
 * payment or deposit it was tied to. Excluded lines are simply included again.
 */
export async function unreconcileBankTransaction(
  db: Database,
  args: { txn: BankTransactionRow; userId: string | null },
): Promise<void> {
  const { txn } = args;
  const now = new Date();
  if (txn.status === 'unreconciled') throw new PostingError('Transaction is not reconciled');

  const reset = {
    status: 'unreconciled',
    reconciliationType: null,
    reconciledInvoiceId: null,
    reconciledBillId: null,
    reconciledPaymentId: null,
    journalEntryId: null,
    categoryAccountId: null,
    depositId: null,
    updatedAt: now,
  };

  // Linked to a payment or a deposit that stays in the books: only the link goes.
  if (txn.reconciliationType === PAYMENT_LINK && txn.reconciledPaymentId) {
    const [payment] = await db
      .select({ id: schema.payments.id, paymentMethod: schema.payments.paymentMethod, checkStatus: schema.payments.checkStatus })
      .from(schema.payments)
      .where(eq(schema.payments.id, txn.reconciledPaymentId))
      .limit(1);
    await atomically(db, (h) => [
      h.update(schema.bankTransactions).set(reset).where(eq(schema.bankTransactions.id, txn.id)),
      ...(payment
        ? [
            h
              .update(schema.payments)
              .set({
                bankTransactionId: null,
                ...(payment.paymentMethod === 'check' && payment.checkStatus === 'cleared' ? { checkStatus: 'printed' } : {}),
                updatedAt: now,
              })
              .where(eq(schema.payments.id, payment.id)),
          ]
        : []),
    ]);
    return;
  }
  if (txn.reconciliationType === DEPOSIT_LINK && txn.depositId) {
    const depositId = txn.depositId;
    await atomically(db, (h) => [
      h.update(schema.bankTransactions).set(reset).where(eq(schema.bankTransactions.id, txn.id)),
      h
        .update(schema.bankDeposits)
        .set({ bankTransactionId: null, updatedAt: now })
        .where(eq(schema.bankDeposits.id, depositId)),
    ]);
    return;
  }

  if (txn.reconciledPaymentId) {
    await voidPayment(db, txn.reconciledPaymentId, { userId: args.userId, date: now });
    return;
  }

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

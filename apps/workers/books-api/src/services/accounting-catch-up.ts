/**
 * Ledger catch-up: book what WeldBooks recorded before every document posted.
 *
 * Until automatic posting existed, only invoice finalize, manual entries, bank
 * categorization and FX differences reached the ledger, and nothing wrote the
 * tax ledger. For one entity this:
 *   1. writes tax-ledger rows for invoices and manual journal entries that are
 *      posted but have none (so the VAT return sees them);
 *   2. corrects credit notes that were posted with the invoice's sign (a
 *      reversal plus a correct entry, both dated today);
 *   3. posts invoices that were sent / paid without being finalized, and
 *      bills that were approved / paid, keeping their status;
 *   4. posts payments that never reached the ledger (their documents were
 *      already settled, so only the entry is written);
 *   5. records a payment for bank lines that were matched to an invoice or
 *      bill without one (only while the document still has an open balance).
 *
 * Everything dated inside a closed period or on/before a lock date is skipped
 * and reported. A dry run builds every posting and checks every lock without
 * writing anything. Running it twice is safe: every posting is idempotent and
 * every step only picks up what is still missing.
 */

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  assertPostingAllowed,
  ClosedPeriodError,
  LockedPeriodError,
  type PostingLockKind,
} from '@weldsuite/books-domain/accounting-guards';
import {
  buildBillPosting,
  buildInvoicePosting,
  buildPaymentPosting,
  postBill,
  postInvoice,
} from './accounting-document-posting';
import { postJournalEntry, PostingError, reverseJournalEntry, type PostingTaxLine } from './accounting-posting';
import { recordPayment } from './accounting-payments';

export interface CatchUpSkipped {
  type: 'invoice' | 'credit_note' | 'bill' | 'payment' | 'bank_transaction' | 'journal_entry';
  id: string;
  number: string | null;
  reason: string;
}

export interface CatchUpResult {
  dryRun: boolean;
  invoices: number;
  creditNotesCorrected: number;
  bills: number;
  payments: number;
  bankTransactions: number;
  taxLines: number;
  skipped: CatchUpSkipped[];
}

const UNPOSTED_INVOICE_STATUSES = ['sent', 'overdue', 'partial', 'paid', 'finalized', 'uncollectible'];
const UNPOSTED_BILL_STATUSES = ['approved', 'partial', 'paid'];

function skipReason(err: unknown): string | null {
  if (err instanceof ClosedPeriodError || err instanceof LockedPeriodError || err instanceof PostingError) {
    return err.message;
  }
  return null;
}

async function checkLocks(
  db: Database,
  entityId: string,
  date: Date,
  kind: PostingLockKind,
  affectsTax: boolean,
  userId: string | null,
) {
  await assertPostingAllowed(db, { entityId, date, kind, affectsTax, userId });
}

function taxRowsFor(taxLines: PostingTaxLine[], args: {
  entityId: string;
  sourceType: string;
  sourceId: string;
  journalEntryId: string;
  taxDate: string;
}) {
  const now = new Date();
  return taxLines
    .filter((t) => t.taxableAmount !== 0 || t.taxAmount !== 0)
    .map((t) => ({
      id: generateId('txl'),
      createdAt: now,
      entityId: args.entityId,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      sourceLineId: t.sourceLineId ?? null,
      journalEntryId: args.journalEntryId,
      taxDate: args.taxDate,
      direction: t.direction,
      taxRateId: t.taxRateId ?? null,
      taxRateName: t.taxRateName ?? null,
      taxCategoryCode: t.taxCategoryCode ?? null,
      rate: t.rate.toFixed(4),
      component: t.component ?? null,
      selfAssessed: t.selfAssessed ?? false,
      taxableAmount: t.taxableAmount.toFixed(2),
      taxAmount: t.taxAmount.toFixed(2),
      currency: t.currency,
      baseTaxableAmount: t.baseTaxableAmount.toFixed(2),
      baseTaxAmount: t.baseTaxAmount.toFixed(2),
      contactId: t.contactId ?? null,
    }));
}

async function journalEntriesWithTaxLines(db: Database, entryIds: string[]): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ journalEntryId: schema.taxLines.journalEntryId })
    .from(schema.taxLines)
    .where(inArray(schema.taxLines.journalEntryId, entryIds));
  return new Set(rows.map((r) => r.journalEntryId));
}

/** 1 + 2: tax ledger for posted invoices, and credit notes posted with the wrong sign. */
async function catchUpPostedInvoices(db: Database, entityId: string, ctx: Ctx) {
  const posted = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.entityId, entityId), isNull(schema.invoices.deletedAt), isNotNull(schema.invoices.journalEntryId)))
    .orderBy(asc(schema.invoices.issueDate));
  const withTax = await journalEntriesWithTaxLines(db, posted.map((i) => i.journalEntryId!));

  for (const invoice of posted) {
    const isCreditNote = invoice.type === 'credit_note';
    const items = await db
      .select()
      .from(schema.invoiceItems)
      .where(and(eq(schema.invoiceItems.invoiceId, invoice.id), isNull(schema.invoiceItems.deletedAt)));

    if (isCreditNote && (await creditNoteHasInvoiceSign(db, invoice.journalEntryId!))) {
      try {
        await checkLocks(db, entityId, new Date(), 'sales', true, ctx.userId);
        if (!ctx.dryRun) {
          await reverseJournalEntry(db, {
            entryId: invoice.journalEntryId!,
            date: new Date(),
            createdBy: ctx.userId,
            lockKind: 'sales',
            description: `Correct sign of credit note ${invoice.invoiceNumber ?? invoice.id}`,
          });
          // Post the credit note correctly; it replaces the reversed entry on the document.
          await postInvoice(db, { ...invoice, journalEntryId: null, issueDate: new Date() }, items, {
            userId: ctx.userId,
            keepStatus: true,
          });
        } else {
          await buildInvoicePosting(db, invoice, items);
        }
        ctx.result.creditNotesCorrected += 1;
      } catch (err) {
        const reason = skipReason(err);
        if (!reason) throw err;
        ctx.result.skipped.push({ type: 'credit_note', id: invoice.id, number: invoice.invoiceNumber, reason });
      }
      continue;
    }

    if (withTax.has(invoice.journalEntryId!)) continue;
    const { taxLines } = await buildInvoicePosting(db, invoice, items);
    const rows = taxRowsFor(taxLines, {
      entityId,
      sourceType: isCreditNote ? 'credit_note' : 'invoice',
      sourceId: invoice.id,
      journalEntryId: invoice.journalEntryId!,
      taxDate: invoice.issueDate.toISOString().slice(0, 10),
    });
    if (rows.length === 0) continue;
    if (!ctx.dryRun) await db.insert(schema.taxLines).values(rows);
    ctx.result.taxLines += rows.length;
  }
}

/** Was this credit note posted like an invoice (receivable debited)? */
async function creditNoteHasInvoiceSign(db: Database, journalEntryId: string): Promise<boolean> {
  const [entry] = await db
    .select({ status: schema.journalEntries.status, postingKey: schema.journalEntries.postingKey })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, journalEntryId))
    .limit(1);
  // Entries from the posting service carry a key and the right sign.
  if (!entry || entry.postingKey || entry.status !== 'posted') return false;
  const lines = await db
    .select({ debit: schema.journalLines.debit, metadata: schema.accounts.metadata, code: schema.accounts.code })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return lines.some(
    (l) =>
      Number(l.debit ?? 0) > 0 &&
      ((l.metadata as { systemRole?: string } | null)?.systemRole === 'accounts_receivable' || l.code === '1300'),
  );
}

/** 1: tax ledger for posted manual journal entries (reversals mirror their original). */
async function catchUpManualEntries(db: Database, entityId: string, ctx: Ctx) {
  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.entityId, entityId),
        isNull(schema.journalEntries.deletedAt),
        inArray(schema.journalEntries.status, ['posted', 'reversed']),
        isNull(schema.journalEntries.postingKey),
        sql`coalesce(${schema.journalEntries.sourceType}, 'manual') = 'manual'`,
      ),
    )
    .orderBy(asc(schema.journalEntries.date));
  const withTax = await journalEntriesWithTaxLines(db, entries.map((e) => e.id));

  const rowsByEntry = new Map<string, ReturnType<typeof taxRowsFor>>();
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const rateById = new Map(rates.map((r) => [r.id, r]));

  for (const entry of entries) {
    if (withTax.has(entry.id)) continue;
    let rows: ReturnType<typeof taxRowsFor>;
    if (entry.reversalOfId) {
      const original = rowsByEntry.get(entry.reversalOfId);
      if (!original) continue;
      const taxDate = entry.date.toISOString().slice(0, 10);
      rows = original.map((r) => ({
        ...r,
        id: generateId('txl'),
        journalEntryId: entry.id,
        taxDate,
        taxableAmount: (-Number(r.taxableAmount)).toFixed(2),
        taxAmount: (-Number(r.taxAmount)).toFixed(2),
        baseTaxableAmount: (-Number(r.baseTaxableAmount)).toFixed(2),
        baseTaxAmount: (-Number(r.baseTaxAmount)).toFixed(2),
      }));
    } else {
      const lines = await db
        .select()
        .from(schema.journalLines)
        .where(and(eq(schema.journalLines.journalEntryId, entry.id), isNull(schema.journalLines.deletedAt)));
      const taxLines: PostingTaxLine[] = [];
      for (const l of lines) {
        const rate = l.taxRateId ? rateById.get(l.taxRateId) : undefined;
        if (!rate) continue;
        const debit = Number(l.debit ?? 0);
        const credit = Number(l.credit ?? 0);
        const tax = Math.abs(Number(l.taxAmount ?? 0));
        const taxable = Math.round((Math.abs(credit - debit) - tax) * 100) / 100;
        taxLines.push({
          sourceLineId: l.id,
          direction: credit > debit ? 'sales' : 'purchase',
          taxRateId: rate.id,
          taxRateName: rate.name,
          taxCategoryCode: rate.taxCategoryCode ?? null,
          rate: Number(rate.rate),
          taxableAmount: taxable,
          taxAmount: tax,
          currency: l.currency ?? 'EUR',
          baseTaxableAmount: taxable,
          baseTaxAmount: tax,
          contactId: l.contactId,
        });
      }
      rows = taxRowsFor(taxLines, {
        entityId,
        sourceType: 'journal',
        sourceId: entry.id,
        journalEntryId: entry.id,
        taxDate: entry.date.toISOString().slice(0, 10),
      });
    }
    rowsByEntry.set(entry.id, rows);
    if (rows.length === 0) continue;
    if (!ctx.dryRun) await db.insert(schema.taxLines).values(rows);
    ctx.result.taxLines += rows.length;
  }
}

/** 3: invoices sent or paid without being finalized. */
async function catchUpUnpostedInvoices(db: Database, entityId: string, ctx: Ctx) {
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.entityId, entityId),
        isNull(schema.invoices.deletedAt),
        isNull(schema.invoices.journalEntryId),
        inArray(schema.invoices.status, UNPOSTED_INVOICE_STATUSES),
        notInArray(schema.invoices.type, ['proforma']),
      ),
    )
    .orderBy(asc(schema.invoices.issueDate));

  for (const invoice of invoices) {
    try {
      const items = await db
        .select()
        .from(schema.invoiceItems)
        .where(and(eq(schema.invoiceItems.invoiceId, invoice.id), isNull(schema.invoiceItems.deletedAt)));
      if (ctx.dryRun) {
        const { taxLines } = await buildInvoicePosting(db, invoice, items);
        await checkLocks(db, entityId, invoice.issueDate, 'sales', taxLines.length > 0, ctx.userId);
      } else {
        await postInvoice(db, invoice, items, { userId: ctx.userId, keepStatus: true });
      }
      ctx.result.invoices += 1;
    } catch (err) {
      const reason = skipReason(err);
      if (!reason) throw err;
      ctx.result.skipped.push({
        type: invoice.type === 'credit_note' ? 'credit_note' : 'invoice',
        id: invoice.id,
        number: invoice.invoiceNumber,
        reason,
      });
    }
  }
}

/** 3: bills approved or paid without being posted. */
async function catchUpUnpostedBills(db: Database, entityId: string, ctx: Ctx) {
  const bills = await db
    .select()
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.entityId, entityId),
        isNull(schema.bills.deletedAt),
        isNull(schema.bills.journalEntryId),
        inArray(schema.bills.status, UNPOSTED_BILL_STATUSES),
      ),
    )
    .orderBy(asc(schema.bills.issueDate));

  for (const bill of bills) {
    try {
      const items = await db
        .select()
        .from(schema.billItems)
        .where(and(eq(schema.billItems.billId, bill.id), isNull(schema.billItems.deletedAt)));
      if (ctx.dryRun) {
        const { taxLines } = await buildBillPosting(db, bill, items);
        await checkLocks(db, entityId, bill.issueDate, 'purchase', taxLines.length > 0, ctx.userId);
      } else {
        await postBill(db, bill, items, { userId: ctx.userId, keepStatus: true });
      }
      ctx.result.bills += 1;
    } catch (err) {
      const reason = skipReason(err);
      if (!reason) throw err;
      ctx.result.skipped.push({ type: 'bill', id: bill.id, number: bill.billNumber, reason });
    }
  }
}

/** 4: payments that never reached the ledger. Their documents are already settled. */
async function catchUpUnpostedPayments(db: Database, entityId: string, ctx: Ctx) {
  const payments = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.entityId, entityId), isNull(schema.payments.deletedAt), isNull(schema.payments.journalEntryId)))
    .orderBy(asc(schema.payments.date));

  for (const payment of payments) {
    try {
      const type = payment.type === 'sent' ? 'sent' : 'received';
      const amount = Number.parseFloat(payment.amount);
      const documentId = payment.invoiceId ?? payment.billId;
      const allocations = documentId
        ? [{ invoiceId: payment.invoiceId, billId: payment.billId, amount, contactId: payment.contactId }]
        : [];
      const lines = await buildPaymentPosting(
        db,
        {
          entityId,
          type,
          amount,
          currency: payment.currency,
          exchangeRate: payment.exchangeRate,
          contactId: payment.contactId,
          bankAccountId: payment.bankAccountId,
          paymentMethod: payment.paymentMethod,
          reference: payment.reference,
        },
        allocations,
      );
      if (ctx.dryRun) {
        await checkLocks(db, entityId, payment.date, 'general', false, ctx.userId);
      } else {
        const now = new Date();
        await postJournalEntry(db, {
          entityId,
          date: payment.date,
          description: `${type === 'received' ? 'Payment received' : 'Payment sent'}${payment.reference ? ` ${payment.reference}` : ''}`,
          reference: payment.reference,
          sourceType: 'payment',
          sourceId: payment.id,
          postingKey: `payment:${payment.id}`,
          lockKind: 'general',
          lines,
          createdBy: ctx.userId,
          alsoWrite: (h, entry) => [
            h.update(schema.payments).set({ journalEntryId: entry.journalEntryId, updatedAt: now }).where(eq(schema.payments.id, payment.id)),
            ...(documentId
              ? [
                  h.insert(schema.paymentAllocations).values({
                    id: generateId('pal'),
                    entityId,
                    paymentId: payment.id,
                    invoiceId: payment.invoiceId,
                    billId: payment.billId,
                    amount: amount.toFixed(2),
                    createdAt: now,
                    updatedAt: now,
                  }),
                ]
              : []),
          ],
        });
      }
      ctx.result.payments += 1;
    } catch (err) {
      const reason = skipReason(err);
      if (!reason) throw err;
      ctx.result.skipped.push({ type: 'payment', id: payment.id, number: payment.reference, reason });
    }
  }
}

/** 5: bank lines matched to a document before a match recorded a payment. */
async function catchUpMatchedBankLines(db: Database, entityId: string, ctx: Ctx) {
  const lines = await db
    .select()
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.entityId, entityId),
        isNull(schema.bankTransactions.deletedAt),
        eq(schema.bankTransactions.status, 'reconciled'),
        isNull(schema.bankTransactions.reconciledPaymentId),
        isNull(schema.bankTransactions.journalEntryId),
        sql`(${schema.bankTransactions.reconciledInvoiceId} is not null or ${schema.bankTransactions.reconciledBillId} is not null)`,
      ),
    )
    .orderBy(asc(schema.bankTransactions.date));

  for (const txn of lines) {
    const isInvoice = Boolean(txn.reconciledInvoiceId);
    const table = isInvoice ? schema.invoices : schema.bills;
    const documentId = (txn.reconciledInvoiceId ?? txn.reconciledBillId)!;
    try {
      const [doc] = await db
        .select({ id: table.id, contactId: table.contactId, balanceDue: table.balanceDue })
        .from(table)
        .where(eq(table.id, documentId))
        .limit(1);
      const open = Number.parseFloat(doc?.balanceDue ?? '0');
      if (!doc || open <= 0) {
        ctx.result.skipped.push({
          type: 'bank_transaction',
          id: txn.id,
          number: txn.reference,
          reason: 'The matched document has no open balance (a payment was probably recorded by hand). Check the line and unreconcile it if needed.',
        });
        continue;
      }
      if (ctx.dryRun) {
        await checkLocks(db, entityId, txn.date, 'general', false, ctx.userId);
      } else {
        const amount = Math.abs(Number.parseFloat(txn.amount));
        await recordPayment(db, {
          entityId,
          type: isInvoice ? 'received' : 'sent',
          amount,
          date: txn.date,
          paymentMethod: 'bank_transfer',
          reference: txn.reference ?? txn.description ?? null,
          contactId: doc.contactId,
          bankAccountId: txn.bankAccountId,
          bankTransactionId: txn.id,
          allocations: [{ [isInvoice ? 'invoiceId' : 'billId']: doc.id, amount: Math.min(amount, open) }],
          userId: ctx.userId,
        });
      }
      ctx.result.bankTransactions += 1;
    } catch (err) {
      const reason = skipReason(err);
      if (!reason) throw err;
      ctx.result.skipped.push({ type: 'bank_transaction', id: txn.id, number: txn.reference, reason });
    }
  }
}

interface Ctx {
  dryRun: boolean;
  userId: string | null;
  result: CatchUpResult;
}

export async function runPostingCatchUp(
  db: Database,
  entityId: string,
  opts: { dryRun: boolean; userId: string | null },
): Promise<CatchUpResult> {
  const ctx: Ctx = {
    dryRun: opts.dryRun,
    userId: opts.userId,
    result: {
      dryRun: opts.dryRun,
      invoices: 0,
      creditNotesCorrected: 0,
      bills: 0,
      payments: 0,
      bankTransactions: 0,
      taxLines: 0,
      skipped: [],
    },
  };

  await catchUpPostedInvoices(db, entityId, ctx);
  await catchUpManualEntries(db, entityId, ctx);
  await catchUpUnpostedInvoices(db, entityId, ctx);
  await catchUpUnpostedBills(db, entityId, ctx);
  await catchUpUnpostedPayments(db, entityId, ctx);
  await catchUpMatchedBankLines(db, entityId, ctx);
  return ctx.result;
}


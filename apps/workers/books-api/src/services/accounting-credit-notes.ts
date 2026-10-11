/**
 * Applying a credit note to an invoice of the same customer.
 *
 * Both documents already sit in receivables (the invoice as a debit, the
 * finalized credit note as a credit), so applying moves no money and posts
 * nothing: it lowers the open balance of both by the same amount, at most the
 * smaller of the two. Whatever the credit note has left (the invoice was
 * already paid, say) stays open as credit for the customer, to apply to another
 * invoice or to refund (a payment sent against the credit note).
 *
 * A credit note is applied to the invoice it credits when it is finalized;
 * POST /api/invoices/:id/apply-credit applies one by hand.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { PostingError, roundMoney, settlementSet } from './accounting-document-posting';

/** Invoice statuses that still have an open balance a credit note can lower. */
const OPEN_STATUSES = new Set(['sent', 'finalized', 'partial', 'overdue']);

export interface CreditApplication {
  creditNoteId: string;
  invoiceId: string;
  amount: number;
}

/**
 * Apply a finalized credit note to an open invoice of the same customer: the
 * invoice it credits unless `invoiceId` names another. Throws a PostingError
 * when it can't be applied; returns null when there is nothing left to apply.
 */
export async function applyCreditNote(
  db: Database,
  creditNoteId: string,
  opts: { invoiceId?: string | null; amount?: number | null } = {},
): Promise<CreditApplication | null> {
  const [note] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, creditNoteId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!note) throw new PostingError('Credit note not found');
  if (note.type !== 'credit_note') throw new PostingError(`${note.invoiceNumber ?? note.id} is not a credit note`);
  if (!note.journalEntryId) throw new PostingError('Finalize the credit note before applying it');

  const invoiceId = opts.invoiceId ?? note.creditNoteForInvoiceId;
  if (!invoiceId) throw new PostingError('Choose the invoice to apply the credit note to');
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!invoice) throw new PostingError('Invoice not found');
  if (invoice.type !== 'standard' && invoice.type !== 'correction') {
    throw new PostingError(`A credit note can only be applied to an invoice, not to ${invoice.invoiceNumber ?? invoice.id}`);
  }
  if (invoice.entityId !== note.entityId) throw new PostingError('The invoice belongs to a different accounting entity');
  if (invoice.contactId !== note.contactId) throw new PostingError('The invoice belongs to a different customer');
  if ((invoice.currency ?? '') !== (note.currency ?? '')) {
    throw new PostingError('The invoice and the credit note are in different currencies');
  }

  const noteOpen = Number.parseFloat(note.balanceDue ?? '0');
  const invoiceOpen = OPEN_STATUSES.has(invoice.status) ? Number.parseFloat(invoice.balanceDue ?? '0') : 0;
  const available = roundMoney(Math.min(noteOpen, invoiceOpen));
  if (opts.amount != null && opts.amount > available + 0.005) {
    throw new PostingError(`At most ${available.toFixed(2)} of this credit note can be applied to ${invoice.invoiceNumber ?? invoice.id}`);
  }
  const amount = roundMoney(opts.amount ?? available);
  if (!(amount > 0)) return null;

  await atomically(db, (h) => [
    h.update(schema.invoices).set(settlementSet(schema.invoices, amount, 'sent')).where(eq(schema.invoices.id, invoice.id)),
    h.update(schema.invoices).set(settlementSet(schema.invoices, amount, 'sent')).where(eq(schema.invoices.id, note.id)),
  ]);
  return { creditNoteId: note.id, invoiceId: invoice.id, amount };
}

/**
 * Apply a credit note that was just finalized to the invoice it credits, as
 * far as that invoice is still open. Never throws: a credit note that can't be
 * applied simply stays open as credit for the customer.
 */
export async function applyCreditNoteOnFinalize(db: Database, creditNoteId: string): Promise<CreditApplication | null> {
  try {
    return await applyCreditNote(db, creditNoteId);
  } catch (err) {
    if (err instanceof PostingError) return null;
    throw err;
  }
}

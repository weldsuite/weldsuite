/**
 * Finalize an invoice or credit note: enforce the jurisdiction's invoice
 * requirements, then post it. Used by POST /:id/finalize, PATCH /:id/send on
 * a draft, auto-finalizing recurring invoices and the ledger catch-up.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  collectInvoiceTaxCategories,
  validateInvoiceForFinalize,
} from '@weldsuite/books-domain/accounting-compliance';
import { loadEntity, postInvoice, PostingError } from './accounting-document-posting';

export class InvoiceComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceComplianceError';
  }
}

export interface FinalizeResult {
  invoice: typeof schema.invoices.$inferSelect;
  journalEntryId: string | null;
  entryNumber: string | null;
  alreadyPosted: boolean;
  warnings: string[];
}

export async function finalizeInvoice(
  db: Database,
  invoiceId: string,
  opts: { userId: string | null; markSent?: boolean; skipCompliance?: boolean },
): Promise<FinalizeResult> {
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!invoice) throw new PostingError('Invoice not found');
  if (invoice.journalEntryId) {
    return { invoice, journalEntryId: invoice.journalEntryId, entryNumber: null, alreadyPosted: true, warnings: [] };
  }
  if (invoice.type === 'proforma') {
    throw new PostingError('Pro forma invoices are not booked. Create a standard invoice to finalize.');
  }

  const warnings: string[] = [];
  if (!opts.skipCompliance) {
    const entity = await loadEntity(db, invoice.entityId);
    const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
    const compliance = await validateInvoiceForFinalize(db, entity, invoice, taxCategories);
    if (!compliance.ok) throw new InvoiceComplianceError(compliance.errors.join(' '));
    warnings.push(...compliance.warnings);
  }

  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)));

  const posted = await postInvoice(db, invoice, items, { userId: opts.userId, markSent: opts.markSent });
  return { invoice, ...posted, warnings };
}

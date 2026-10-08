/**
 * Finalize an invoice or credit note: enforce the jurisdiction's invoice
 * requirements, then post it. Used by POST /:id/finalize, PATCH /:id/send on
 * a draft, auto-finalizing recurring invoices and the ledger catch-up.
 *
 * US sales tax (docs/plans/weldbooks-us.md §3):
 * - the draft is recalculated first, so the tax that posts is today's answer
 *   for the saved lines and addresses;
 * - an invoice that needs tax but has no ship-to (or bill-to) state and ZIP is
 *   refused (`ADDRESS_REQUIRED`), and so is one the engine could not tax
 *   (`TAX_ENGINE_UNAVAILABLE`): zero tax is never posted for a failure;
 * - after posting, a provider engine records the document (invoice commit,
 *   credit memo reversal). A failure there never undoes the ledger; it is kept
 *   in `tax_warnings` and retried by `POST /api/invoices/:id/commit-tax`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SalesTaxEngineError } from '@weldsuite/books-domain/sales-tax';
import {
  collectInvoiceTaxCategories,
  validateInvoiceForFinalize,
} from '@weldsuite/books-domain/accounting-compliance';
import { loadEntity, postInvoice, PostingError } from './accounting-document-posting';
import { SalesTaxDocumentError, addressRequired, engineUnavailable } from './sales-tax/errors';
import { loadSalesTaxEntity, usesSalesTax } from './sales-tax/document-tax';
import { recalculateStoredInvoice } from './sales-tax/persist';
import { syncInvoiceWithProvider, type ProviderSyncResult } from './sales-tax/provider-sync';
import type { SalesTaxRuntime } from './sales-tax/runtime';

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
  /** US provider engines: the outcome of recording the document with the provider. */
  taxSync?: ProviderSyncResult;
}

export async function finalizeInvoice(
  db: Database,
  invoiceId: string,
  opts: {
    userId: string | null;
    markSent?: boolean;
    skipCompliance?: boolean;
    /** Opens the stored engine credentials; needed for provider engines. */
    tax?: SalesTaxRuntime;
  },
): Promise<FinalizeResult> {
  const [stored] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!stored) throw new PostingError('Invoice not found');
  if (stored.journalEntryId) {
    return { invoice: stored, journalEntryId: stored.journalEntryId, entryNumber: null, alreadyPosted: true, warnings: [] };
  }
  if (stored.type === 'proforma') {
    throw new PostingError('Pro forma invoices are not booked. Create a standard invoice to finalize.');
  }

  let invoice = stored;
  let items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)));

  const warnings: string[] = [];
  const salesTax = usesSalesTax(await loadSalesTaxEntity(db, stored.entityId));
  if (salesTax && items.length > 0) {
    // The tax that posts is the engine's answer for what is saved now.
    try {
      const refreshed = await recalculateStoredInvoice(db, stored, items, opts.tax, { forFinalize: true });
      invoice = refreshed.invoice;
      items = refreshed.items;
      warnings.push(...(refreshed.calc.salesTax?.warnings ?? []));
    } catch (err) {
      if (err instanceof SalesTaxEngineError) throw engineUnavailable(err);
      throw err;
    }
  }

  if (!opts.skipCompliance) {
    const entity = await loadEntity(db, invoice.entityId);
    const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
    const compliance = await validateInvoiceForFinalize(db, entity, invoice, taxCategories);
    if (!compliance.ok) throw new InvoiceComplianceError(compliance.errors.join(' '));
    warnings.push(...compliance.warnings);
  }

  const posted = await postInvoice(db, invoice, items, { userId: opts.userId, markSent: opts.markSent });

  let taxSync: ProviderSyncResult | undefined;
  if (salesTax && posted.journalEntryId && !posted.alreadyPosted && opts.tax) {
    taxSync = await syncInvoiceWithProvider(db, invoiceId, opts.tax);
    if (taxSync.warning) warnings.push(taxSync.warning);
  }
  return { invoice, ...posted, warnings, ...(taxSync ? { taxSync } : {}) };
}

export { SalesTaxDocumentError, addressRequired };

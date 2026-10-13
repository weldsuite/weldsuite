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
  getContactVatNumber,
  validateInvoiceForFinalize,
} from '@weldsuite/books-domain/accounting-compliance';
import { loadEntity, postInvoice, PostingError } from './accounting-document-posting';
import { resolveGstSupply, type GstSupply } from './accounting-gst';
import { applyCreditNoteOnFinalize, type CreditApplication } from './accounting-credit-notes';
import { SalesTaxDocumentError, addressRequired, engineUnavailable } from './sales-tax/errors';
import { loadSalesTaxEntity, usesSalesTax } from './sales-tax/document-tax';
import { recalculateStoredInvoice } from './sales-tax/persist';
import { syncInvoiceWithProvider, type ProviderSyncResult } from './sales-tax/provider-sync';
import type { SalesTaxRuntime } from './sales-tax/runtime';

/** True when the invoice charges GST at a slab rate that was not split into CGST + SGST / IGST (no place of supply). */
function gstSplitMissing(invoice: typeof schema.invoices.$inferSelect): boolean {
  return (invoice.taxBreakdown ?? []).some(
    (row) => row.taxRate > 0 && !row.component && !row.selfAssessed && row.taxCategoryCode !== 'reverse_charge',
  );
}

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
  /** A credit note: what was applied to the invoice it credits. */
  creditApplied?: CreditApplication | null;
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

  // India GST: the CGST + SGST / IGST split follows the place of supply as it stands now. A credit note
  // keeps the split of the invoice it credits.
  const gstSupply: GstSupply | null = await resolveGstSupply(db, {
    entityId: invoice.entityId,
    contactId: invoice.contactId,
    placeOfSupply: invoice.placeOfSupply,
    shippingAddress: invoice.shippingAddress,
    billingAddress: invoice.billingAddress,
  });
  if (gstSupply && items.length > 0 && invoice.type !== 'credit_note') {
    const refreshed = await recalculateStoredInvoice(db, invoice, items, opts.tax, { gst: gstSupply });
    invoice = refreshed.invoice;
    items = refreshed.items;
  }

  if (!opts.skipCompliance) {
    const entity = await loadEntity(db, invoice.entityId);
    const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
    const compliance = await validateInvoiceForFinalize(db, entity, invoice, taxCategories);
    if (gstSupply && invoice.type !== 'credit_note' && gstSplitMissing(invoice)) {
      compliance.errors.push(
        "GST is charged but the place of supply is unknown, so it can't be split into CGST + SGST or IGST. Choose the place of supply on the invoice (or add the customer's GSTIN or address state) before finalizing.",
      );
      compliance.ok = false;
    }
    if (!compliance.ok) throw new InvoiceComplianceError(compliance.errors.join(' '));
    warnings.push(...compliance.warnings);
  }

  // The buyer's tax id (GSTIN / VAT number) and place of supply as they were when the invoice was booked.
  // A credit note keeps those of the invoice it was copied from.
  const contactTaxNumber = invoice.contactTaxNumber ?? ((await getContactVatNumber(db, invoice.contactId))?.trim() || null);
  const snapshot = { contactTaxNumber, ...(gstSupply ? { placeOfSupply: gstSupply.placeOfSupply } : {}) };
  const posted = await postInvoice(db, invoice, items, { userId: opts.userId, markSent: opts.markSent, snapshot });
  invoice = { ...invoice, ...snapshot };

  // A credit note lowers what is still open on the invoice it credits.
  let creditApplied: CreditApplication | null = null;
  if (invoice.type === 'credit_note' && posted.journalEntryId && !posted.alreadyPosted) {
    creditApplied = await applyCreditNoteOnFinalize(db, invoiceId);
  }

  let taxSync: ProviderSyncResult | undefined;
  if (salesTax && posted.journalEntryId && !posted.alreadyPosted && opts.tax) {
    taxSync = await syncInvoiceWithProvider(db, invoiceId, opts.tax);
    if (taxSync.warning) warnings.push(taxSync.warning);
  }
  return { invoice, ...posted, warnings, creditApplied, ...(taxSync ? { taxSync } : {}) };
}

export { SalesTaxDocumentError, addressRequired };

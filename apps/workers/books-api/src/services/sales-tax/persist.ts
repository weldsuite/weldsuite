/**
 * Writing a tax calculation onto an invoice and its lines, and recalculating a
 * stored draft. Shared by the invoice routes, finalize and recurring
 * generation, so every path stores the same columns.
 */

import { eq } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SalesTaxEngineError } from '@weldsuite/books-domain/sales-tax';
import {
  calculateDocumentTax,
  untaxedDocumentTax,
  type CalculatedDocumentTax,
  type DocumentTaxItem,
} from '../accounting-tax-resolve';
import type { UsDocumentContext } from './document-tax';
import { SalesTaxDocumentError, addressRequired } from './errors';
import type { SalesTaxRuntime } from './runtime';

type InvoiceRow = typeof schema.invoices.$inferSelect;
type InvoiceItemRow = typeof schema.invoiceItems.$inferSelect;

export const ENGINE_UNAVAILABLE_WARNING = 'tax_engine_unavailable';

/** Warning codes that describe the last provider sync; replaced, never stacked. */
const SYNC_WARNING_PREFIXES = ['commit_failed', 'reverse_failed', 'reverse_unsupported', 'reverse_skipped'];

export function invoiceKind(invoice: Pick<InvoiceRow, 'type'>): UsDocumentContext['kind'] {
  if (invoice.type === 'credit_note') return 'credit_memo';
  if (invoice.type === 'proforma') return 'estimate';
  return 'invoice';
}

export function invoiceDocumentContext(invoice: InvoiceRow): UsDocumentContext {
  return {
    kind: invoiceKind(invoice),
    documentId: invoice.id,
    documentNumber: invoice.invoiceNumber,
    contactId: invoice.contactId,
    issueDate: invoice.issueDate,
    currency: invoice.currency,
    billingAddress: invoice.billingAddress,
    shippingAddress: invoice.shippingAddress,
    shipFromAddress: invoice.shipFromAddress,
    marketplaceFacilitated: invoice.marketplaceFacilitated,
    originalInvoiceId: invoice.creditNoteForInvoiceId,
  };
}

export function invoiceItemToTaxItem(item: InvoiceItemRow): DocumentTaxItem {
  return {
    id: item.id,
    description: item.description,
    quantity: item.quantity ?? '1',
    unitPrice: item.unitPrice,
    discountPercent: item.discountPercent ?? '0',
    sortOrder: item.sortOrder,
    productId: item.productId,
    taxRateId: item.taxRateId,
    taxRate: item.taxRate,
    taxCode: item.taxCode,
    taxUse: item.taxUse,
    taxIncluded: item.taxIncluded,
    taxOverrideAmount: item.taxOverrideAmount,
    taxOverrideReason: item.taxOverrideReason,
  };
}

/** The invoice header columns of a calculation. */
export function invoiceTaxColumns(calc: CalculatedDocumentTax) {
  return {
    subtotal: calc.subtotal,
    discountTotal: calc.discountTotal,
    taxTotal: calc.taxTotal,
    total: calc.total,
    taxBreakdown: calc.taxBreakdown,
    ...(calc.salesTax
      ? {
          taxEngine: calc.salesTax.engine,
          taxEngineRef: calc.salesTax.engineRef,
          taxCalculatedAt: calc.salesTax.calculatedAt,
          taxWarnings: calc.salesTax.warnings,
          marketplaceFacilitated: calc.salesTax.marketplaceFacilitated,
        }
      : {}),
  };
}

/** The line columns of a calculation, for line `index`. */
export function itemTaxColumns(calc: CalculatedDocumentTax, index: number) {
  const processed = calc.processedItems[index];
  return {
    taxRateId: processed.taxRateId,
    taxRate: processed.taxRate,
    taxAmount: processed.taxAmount,
    lineTotal: processed.lineTotal,
    lineTotalWithTax: processed.lineTotalWithTax,
  };
}

export type DraftTaxResult =
  | { ok: true; calc: CalculatedDocumentTax }
  /** The engine could not answer; `calc` has the totals without tax. */
  | { ok: false; message: string; code: string; calc: CalculatedDocumentTax };

/**
 * `calculateDocumentTax` for a draft: an engine failure is a result, not an
 * exception, so the draft can still be saved (without tax, flagged). Finalizing
 * recalculates and refuses while the engine is down.
 */
export async function calculateDraftTax(
  db: Database,
  args: Parameters<typeof calculateDocumentTax>[1],
): Promise<DraftTaxResult> {
  try {
    return { ok: true, calc: await calculateDocumentTax(db, args) };
  } catch (err) {
    if (err instanceof SalesTaxEngineError) {
      return { ok: false, message: err.message, code: err.code, calc: untaxedDocumentTax(args.items) };
    }
    throw err;
  }
}

export function engineUnavailableWarning(message: string): string {
  return `${ENGINE_UNAVAILABLE_WARNING}: ${message}`;
}

/** Warnings with the previous provider-sync outcome (and any engine-unavailable note) replaced. */
export function mergeSyncWarning(existing: string[] | null | undefined, next?: string): string[] {
  const kept = (existing ?? []).filter(
    (w) => !SYNC_WARNING_PREFIXES.some((prefix) => w.startsWith(prefix)) && !w.startsWith(ENGINE_UNAVAILABLE_WARNING),
  );
  return next ? [...kept, next] : kept;
}

export interface RecalculatedInvoice {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  calc: CalculatedDocumentTax;
}

/**
 * Recalculate a stored draft invoice or credit memo and write the result
 * (header and lines in one batch). Throws `SalesTaxEngineError` when the
 * engine can't answer; the stored draft is left as it was.
 */
export async function recalculateStoredInvoice(
  db: Database,
  invoice: InvoiceRow,
  items: InvoiceItemRow[],
  runtime?: SalesTaxRuntime,
  opts: { forFinalize?: boolean } = {},
): Promise<RecalculatedInvoice> {
  const calc = await calculateDocumentTax(db, {
    entityId: invoice.entityId,
    direction: 'sales',
    items: items.map(invoiceItemToTaxItem),
    document: invoiceDocumentContext(invoice),
    runtime,
  });
  if (opts.forFinalize && calc.salesTax) {
    // Finalizing posts this tax: a document that can't be taxed properly must not post.
    if (calc.salesTax.addressIncomplete) throw addressRequired();
    if (calc.salesTax.warnings.includes('rates_not_configured')) {
      throw new SalesTaxDocumentError(
        'TAX_RATES_NOT_CONFIGURED',
        `The entity is registered for sales tax in ${calc.salesTax.shipToState ?? 'the ship-to state'}, but no rate is in force there on the invoice date. Add the jurisdictions and rates under Sales tax before finalizing.`,
      );
    }
  }

  const now = new Date();
  const header = {
    ...invoiceTaxColumns(calc),
    balanceDue: (Number.parseFloat(calc.total) - Number.parseFloat(invoice.amountPaid ?? '0')).toFixed(2),
    updatedAt: now,
  };
  const lineColumns = items.map((_, idx) => ({ ...itemTaxColumns(calc, idx), updatedAt: now }));

  await atomically(db, (h) => [
    h.update(schema.invoices).set(header).where(eq(schema.invoices.id, invoice.id)),
    ...items.map((item, idx) => h.update(schema.invoiceItems).set(lineColumns[idx]).where(eq(schema.invoiceItems.id, item.id))),
  ]);

  return {
    invoice: { ...invoice, ...header },
    items: items.map((item, idx) => ({ ...item, ...lineColumns[idx] })),
    calc,
  };
}

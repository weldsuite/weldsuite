/**
 * India GST return worksheet (GSTR-1 and GSTR-3B summary) for a period.
 *
 * Reads the tax ledger (`tax_lines`, written with every posting) of an India
 * entity and the invoices behind it, and hands them to the pure computation in
 * `@weldsuite/books-domain/jurisdictions/in`. It is a worksheet to reconcile
 * with the GST portal: nothing is stored and nothing is filed.
 */

import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  computeGstWorksheet,
  type GstDocument,
  type GstInvoiceLine,
  type GstLedgerEntry,
  type GstWorksheet,
} from '@weldsuite/books-domain/jurisdictions/in';
import { toBaseCurrency } from './accounting-currency';
import { getEntityStateCode } from './accounting-tax-totals';
import { isoDate } from './accounting-tax-ledger';

export class GstReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GstReturnError';
  }
}

const num = (value: string | number | null | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The GSTIN of each contact, from its company record, for invoices booked before the number was snapshotted. */
async function liveGstins(db: Database, contactIds: string[]): Promise<Map<string, string>> {
  if (contactIds.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.parties.id, vatNumber: schema.companies.vatNumber })
    .from(schema.parties)
    .leftJoin(schema.companies, eq(schema.parties.companyId, schema.companies.id))
    .where(inArray(schema.parties.id, contactIds));
  return new Map(rows.filter((r) => r.vatNumber).map((r) => [r.id, r.vatNumber!.trim()]));
}

type EntityRow = typeof schema.entities.$inferSelect;

/** The India entity the worksheet is for; anything else has no GST return. */
async function loadIndiaEntity(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new GstReturnError('Accounting entity not found');
  if (entity.jurisdictionCode?.toUpperCase() !== 'IN') {
    throw new GstReturnError("This entity's jurisdiction has no GST return.");
  }
  return entity;
}

/** The tax ledger rows of the period, by tax date. */
async function loadTaxLedger(db: Database, entityId: string, periodStart: string, periodEnd: string) {
  return db
    .select({
      sourceType: schema.taxLines.sourceType,
      sourceId: schema.taxLines.sourceId,
      direction: schema.taxLines.direction,
      component: schema.taxLines.component,
      rate: schema.taxLines.rate,
      taxCategoryCode: schema.taxLines.taxCategoryCode,
      selfAssessed: schema.taxLines.selfAssessed,
      baseTaxableAmount: schema.taxLines.baseTaxableAmount,
      baseTaxAmount: schema.taxLines.baseTaxAmount,
    })
    .from(schema.taxLines)
    .where(
      and(
        eq(schema.taxLines.entityId, entityId),
        gte(schema.taxLines.taxDate, isoDate(periodStart)),
        lte(schema.taxLines.taxDate, isoDate(periodEnd)),
      ),
    );
}

type LedgerRow = Awaited<ReturnType<typeof loadTaxLedger>>[number];

function toLedgerEntry(r: LedgerRow): GstLedgerEntry {
  return {
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    // US-only 'use' rows never exist for India; anything not a purchase is outward.
    direction: r.direction === 'purchase' ? 'purchase' : 'sales',
    component: r.component,
    rate: num(r.rate),
    taxCategoryCode: r.taxCategoryCode,
    selfAssessed: r.selfAssessed,
    taxableAmount: num(r.baseTaxableAmount),
    taxAmount: num(r.baseTaxAmount),
  };
}

async function loadInvoiceRows(db: Database, invoiceIds: string[]) {
  return db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.invoiceNumber,
      type: schema.invoices.type,
      issueDate: schema.invoices.issueDate,
      total: schema.invoices.total,
      currency: schema.invoices.currency,
      exchangeRate: schema.invoices.exchangeRate,
      placeOfSupply: schema.invoices.placeOfSupply,
      contactTaxNumber: schema.invoices.contactTaxNumber,
      contactId: schema.invoices.contactId,
      contactName: schema.invoices.contactName,
      creditNoteForInvoiceId: schema.invoices.creditNoteForInvoiceId,
    })
    .from(schema.invoices)
    .where(inArray(schema.invoices.id, invoiceIds));
}

type InvoiceRow = Awaited<ReturnType<typeof loadInvoiceRows>>[number];

/** The number of each credited (original) invoice, by id. */
async function loadOriginalNumbers(db: Database, invoices: InvoiceRow[]) {
  const originalIds = [...new Set(invoices.map((i) => i.creditNoteForInvoiceId).filter((id): id is string => Boolean(id)))];
  const originals = originalIds.length
    ? await db
        .select({ id: schema.invoices.id, number: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(inArray(schema.invoices.id, originalIds))
    : [];
  return new Map(originals.map((o) => [o.id, o.number]));
}

function toGstDocument(
  inv: InvoiceRow,
  baseCurrency: string | null,
  originalNumber: Map<string, string | null>,
  gstins: Map<string, string>,
): GstDocument {
  const sameCurrency = !inv.currency || inv.currency === baseCurrency;
  const total = num(inv.total);
  return {
    id: inv.id,
    kind: inv.type === 'credit_note' ? 'credit_note' : 'invoice',
    number: inv.number ?? inv.id,
    date: isoDate(inv.issueDate),
    counterpartyName: inv.contactName ?? '',
    gstin: (inv.contactTaxNumber || (inv.contactId ? gstins.get(inv.contactId) : undefined) || null) as string | null,
    placeOfSupply: inv.placeOfSupply,
    total: sameCurrency ? total : toBaseCurrency(total, num(inv.exchangeRate) || 1),
    originalNumber: inv.creditNoteForInvoiceId ? (originalNumber.get(inv.creditNoteForInvoiceId) ?? null) : null,
  };
}

async function loadInvoiceItems(db: Database, invoiceIds: string[]) {
  return db
    .select({
      invoiceId: schema.invoiceItems.invoiceId,
      hsnSac: schema.invoiceItems.hsnSac,
      unit: schema.invoiceItems.unit,
      quantity: schema.invoiceItems.quantity,
      lineTotal: schema.invoiceItems.lineTotal,
      taxAmount: schema.invoiceItems.taxAmount,
      taxRate: schema.invoiceItems.taxRate,
    })
    .from(schema.invoiceItems)
    .where(and(inArray(schema.invoiceItems.invoiceId, invoiceIds), isNull(schema.invoiceItems.deletedAt)));
}

type InvoiceItemRow = Awaited<ReturnType<typeof loadInvoiceItems>>[number];

function toGstInvoiceLine(item: InvoiceItemRow, inv: InvoiceRow, baseCurrency: string | null): GstInvoiceLine {
  const rate = !inv.currency || inv.currency === baseCurrency ? 1 : 1 / (num(inv.exchangeRate) || 1);
  return {
    documentId: item.invoiceId,
    sign: inv.type === 'credit_note' ? -1 : 1,
    hsnSac: item.hsnSac,
    unit: item.unit,
    quantity: num(item.quantity),
    taxableValue: Math.round(num(item.lineTotal) * rate * 100) / 100,
    taxAmount: Math.round(num(item.taxAmount) * rate * 100) / 100,
    slabRate: num(item.taxRate),
  };
}

/** The invoices and credit notes behind the ledger rows, and their item lines. */
async function loadGstDocuments(
  db: Database,
  entity: EntityRow,
  invoiceIds: string[],
): Promise<{ documents: GstDocument[]; lines: GstInvoiceLine[] }> {
  if (invoiceIds.length === 0) return { documents: [], lines: [] };

  const invoices = await loadInvoiceRows(db, invoiceIds);
  const originalNumber = await loadOriginalNumbers(db, invoices);

  const unnumbered = invoices.filter((i) => !i.contactTaxNumber && i.contactId).map((i) => i.contactId!);
  const gstins = await liveGstins(db, [...new Set(unnumbered)]);

  const documents = invoices.map((inv) => toGstDocument(inv, entity.baseCurrency, originalNumber, gstins));

  const items = await loadInvoiceItems(db, invoiceIds);
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const lines: GstInvoiceLine[] = [];
  for (const item of items) {
    const inv = byId.get(item.invoiceId);
    if (!inv) continue;
    lines.push(toGstInvoiceLine(item, inv, entity.baseCurrency));
  }
  return { documents, lines };
}

/** The worksheet of an India entity for `periodStart`..`periodEnd` (inclusive, by tax date). */
export async function loadGstWorksheet(
  db: Database,
  entityId: string,
  periodStart: string,
  periodEnd: string,
): Promise<GstWorksheet> {
  const entity = await loadIndiaEntity(db, entityId);
  const ledger = await loadTaxLedger(db, entityId, periodStart, periodEnd);
  const entries = ledger.map(toLedgerEntry);

  const invoiceIds = [
    ...new Set(
      ledger
        .filter((r) => (r.sourceType === 'invoice' || r.sourceType === 'credit_note') && r.sourceId)
        .map((r) => r.sourceId!),
    ),
  ];
  const { documents, lines } = await loadGstDocuments(db, entity, invoiceIds);

  return computeGstWorksheet({
    periodStart: isoDate(periodStart),
    periodEnd: isoDate(periodEnd),
    entityStateCode: getEntityStateCode(entity) ?? null,
    entries,
    documents,
    lines,
  });
}

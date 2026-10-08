/**
 * Sales tax for one document (docs/plans/weldbooks-us.md §2-3).
 *
 * `calculateUsDocumentTax` turns an invoice, estimate, credit memo or bill's
 * lines and addresses into the sales tax request of the entity's engine and
 * the engine's answer into what the document stores: line totals and tax, the
 * jurisdiction breakdown, warnings. The same function backs the draft
 * recalculation, finalize and the live preview, so a form shows exactly what
 * posting will book.
 *
 * - Ship-from: the document's own address, else the entity's. Ship-to: the
 *   shipping address, else the billing address (bills: the delivery address,
 *   else the entity's).
 * - A line's tax code is the line's, else its product's tax class, else
 *   `general` (a product marked not taxable is `non_taxable`).
 * - A credit memo never asks the engine: it reuses the original invoice's
 *   jurisdictions and rates (`reverseResultForCreditMemo`).
 * - An engine failure throws; callers keep the draft's last calculation and
 *   refuse to finalize. It never becomes zero tax.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DocumentTaxBreakdownRow, PostalAddress, StoredPostalAddress } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import {
  createSalesTaxEngine,
  fromCents,
  reverseResultForCreditMemo,
  roundHalfUp,
  salesTaxResultToBreakdown,
  stateCodeOf,
  toCents,
  zip5Of,
  SalesTaxEngineError,
  type ExemptionCertificateRef,
  type SalesTaxEngine,
  type SalesTaxRegistration,
  type SalesTaxRequest,
  type SalesTaxRequestLine,
  type SalesTaxResult,
  type TaxUse,
} from '@weldsuite/books-domain/sales-tax';
import {
  buildManualEngineData,
  loadCustomerCertificates,
  loadSalesTaxContext,
  toRegistration,
} from '@weldsuite/books-domain/sales-tax/load';
import {
  DEFAULT_WELD_TAX_CODE,
  isAvalaraTaxCode,
  isStripeTaxCode,
  isWeldTaxCode,
} from '@weldsuite/books-domain/jurisdictions/us/tax-codes';
import { getAdapter, hasAdapter } from '@weldsuite/books-domain/jurisdictions/registry';
import { SalesTaxDocumentError, addressRequired } from './errors';
import type { SalesTaxRuntime } from './runtime';

export type UsDocumentKind = 'invoice' | 'estimate' | 'credit_memo' | 'bill';

export interface UsTaxItemInput {
  /** The id the line row has (or will get): breakdown rows and the ledger refer to it. */
  id: string;
  description?: string | null;
  quantity?: string | null;
  unitPrice: string;
  discountPercent?: string | null;
  sortOrder?: number | null;
  productId?: string | null;
  taxCode?: string | null;
  taxUse?: string | null;
  taxIncluded?: boolean | null;
  taxOverrideAmount?: string | null;
  taxOverrideReason?: string | null;
  /** Bills: the vendor charged no sales tax, so accrue use tax on this line. */
  accrueUseTax?: boolean | null;
  /** Credit memos: the invoice line this one credits, when the client knows it. */
  originalLineId?: string | null;
}

export interface UsDocumentContext {
  kind: UsDocumentKind;
  documentId?: string | null;
  documentNumber?: string | null;
  contactId?: string | null;
  issueDate: Date | string;
  currency?: string | null;
  billingAddress?: StoredPostalAddress | null;
  shippingAddress?: StoredPostalAddress | null;
  /** Bills: where the goods were delivered. */
  deliveryAddress?: StoredPostalAddress | null;
  shipFromAddress?: StoredPostalAddress | null;
  marketplaceFacilitated?: boolean | null;
  /** Credit memos: the invoice being credited. */
  originalInvoiceId?: string | null;
}

export interface UsProcessedItem {
  id: string;
  lineTotal: string;
  lineTotalWithTax: string;
  taxAmount: string;
  taxRateId: null;
  /** The combined rate that applied to the taxable part, e.g. "8.2500". */
  taxRate: string | null;
  taxCode: string;
  overridden: boolean;
}

export interface UsTaxMeta {
  engine: string;
  engineRef: string | null;
  calculatedAt: Date;
  warnings: string[];
  marketplaceFacilitated: boolean;
  shipToState: string | null;
  shipToPostalCode: string | null;
  /** The document needs tax but has no ship-to (or bill-to) state and ZIP: finalizing is refused. */
  addressIncomplete: boolean;
  /** Credit memos: the original line each credit line reverses. */
  originalLineIds?: Record<string, string | null>;
}

export interface UsDocumentTaxCalculation {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  taxBreakdown: DocumentTaxBreakdownRow[];
  processedItems: UsProcessedItem[];
  salesTax: UsTaxMeta;
}

export interface SalesTaxEntityInfo {
  id: string;
  jurisdictionCode: string;
  baseCurrency: string;
  address: PostalAddress | null;
}

export async function loadSalesTaxEntity(db: Database, entityId: string): Promise<SalesTaxEntityInfo | null> {
  const [entity] = await db
    .select({
      id: schema.entities.id,
      jurisdictionCode: schema.entities.jurisdictionCode,
      baseCurrency: schema.entities.baseCurrency,
      address: schema.entities.address,
    })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) return null;
  return { ...entity, address: normalizePostalAddress(entity.address) };
}

/** The entity's jurisdiction uses the sales tax engine (the US). */
export function usesSalesTax(entity: { jurisdictionCode: string } | null | undefined): boolean {
  return Boolean(entity && hasAdapter(entity.jurisdictionCode) && getAdapter(entity.jurisdictionCode).features.salesTax);
}

function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

interface LineAmounts {
  quantity: number;
  /** quantity x price less the discount, to the cent (tax-inclusive when the line says so). */
  amount: number;
  discount: number;
}

function lineAmounts(item: UsTaxItemInput): LineAmounts {
  const quantity = num(item.quantity, 1);
  const gross = quantity * num(item.unitPrice);
  const discount = gross * (num(item.discountPercent) / 100);
  return { quantity, amount: roundCents(gross - discount), discount };
}

function useOf(value: string | null | undefined): TaxUse | undefined {
  return value === 'business' || value === 'personal' ? value : undefined;
}

/** A WeldBooks code, or a provider's own code the line carries on purpose. Anything else is ignored. */
function usableTaxCode(value: string | null | undefined): string | undefined {
  const code = value?.trim();
  if (!code) return undefined;
  if (isWeldTaxCode(code) || isStripeTaxCode(code) || isAvalaraTaxCode(code)) return code;
  return undefined;
}

/** The line's own code, else `non_taxable` for a product not marked taxable, else the product's tax class, else `general`. */
export function resolveLineTaxCode(
  lineCode: string | null | undefined,
  product: { taxClass: string | null; taxable: boolean | null } | undefined,
): string {
  return (
    usableTaxCode(lineCode) ??
    (product && product.taxable === false ? 'non_taxable' : undefined) ??
    usableTaxCode(product?.taxClass) ??
    DEFAULT_WELD_TAX_CODE
  );
}

async function loadProducts(db: Database, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, { taxClass: string | null; taxable: boolean | null }>();
  const rows = await db
    .select({ id: schema.products.id, taxClass: schema.products.taxClass, taxable: schema.products.taxable })
    .from(schema.products)
    .where(inArray(schema.products.id, unique));
  return new Map(rows.map((r) => [r.id, { taxClass: r.taxClass, taxable: r.taxable }]));
}

async function loadCustomer(db: Database, contactId: string | null | undefined): Promise<{ use?: TaxUse }> {
  if (!contactId) return {};
  const [party] = await db
    .select({ taxUse: schema.parties.taxUse })
    .from(schema.parties)
    .where(eq(schema.parties.id, contactId))
    .limit(1);
  return { use: useOf(party?.taxUse) };
}

/** The ship-to: the shipping address when it names a state, else the billing address; null when neither does. */
export function pickShipTo(
  ...candidates: Array<StoredPostalAddress | null | undefined>
): PostalAddress | null {
  const addresses = candidates.map((a) => normalizePostalAddress(a)).filter((a): a is PostalAddress => a !== null);
  return addresses.find((a) => stateCodeOf(a)) ?? addresses[0] ?? null;
}

function isForeign(address: PostalAddress | null): boolean {
  const country = address?.country?.trim().toUpperCase();
  return Boolean(country && country !== 'US' && country !== 'USA' && country !== 'UNITED STATES');
}

/**
 * A US invoice with a taxable line (or any line, when registered anywhere)
 * needs a ship-to or bill-to state and ZIP. A buyer abroad needs neither.
 */
export function shipToIncomplete(args: {
  shipTo: PostalAddress | null;
  registrations: SalesTaxRegistration[];
  lines: Array<{ amount: number; taxCode: string }>;
}): boolean {
  if (isForeign(args.shipTo)) return false;
  const registered = args.registrations.some((r) => r.status === 'registered');
  const needs = args.lines.some((l) => l.amount !== 0 && (registered || l.taxCode !== 'non_taxable'));
  if (!needs) return false;
  return !stateCodeOf(args.shipTo) || !zip5Of(args.shipTo);
}

export function assertShipToForTax(args: Parameters<typeof shipToIncomplete>[0]): void {
  if (shipToIncomplete(args)) throw addressRequired();
}

const NO_CREDENTIALS: SalesTaxRuntime = {
  decrypt: () =>
    Promise.reject(new SalesTaxEngineError('The stored engine credentials cannot be read in this context', 'not_configured')),
};

interface EngineContext {
  engine: SalesTaxEngine;
  engineId: string;
  registrations: SalesTaxRegistration[];
}

/** The entity's engine, or for use tax under Stripe (which can't compute it) the manual engine's own data. */
async function loadEngine(
  db: Database,
  entityId: string,
  runtime: SalesTaxRuntime,
  purpose: 'sales' | 'use',
): Promise<EngineContext> {
  const ctx = await loadSalesTaxContext(db, entityId, { decrypt: runtime.decrypt, fetch: runtime.fetch });
  if (purpose === 'use' && ctx.engineId === 'stripe_tax') {
    const [jurisdictions, rates, zones, rules] = await Promise.all([
      db
        .select()
        .from(schema.salesTaxJurisdictions)
        .where(
          and(
            eq(schema.salesTaxJurisdictions.entityId, entityId),
            isNull(schema.salesTaxJurisdictions.deletedAt),
            eq(schema.salesTaxJurisdictions.isActive, true),
          ),
        ),
      db
        .select()
        .from(schema.salesTaxJurisdictionRates)
        .where(
          and(eq(schema.salesTaxJurisdictionRates.entityId, entityId), isNull(schema.salesTaxJurisdictionRates.deletedAt)),
        ),
      db
        .select()
        .from(schema.salesTaxZones)
        .where(and(eq(schema.salesTaxZones.entityId, entityId), isNull(schema.salesTaxZones.deletedAt))),
      db
        .select()
        .from(schema.salesTaxTaxabilityRules)
        .where(
          and(eq(schema.salesTaxTaxabilityRules.entityId, entityId), isNull(schema.salesTaxTaxabilityRules.deletedAt)),
        ),
    ]);
    const manual = createSalesTaxEngine({
      engine: 'manual',
      manual: buildManualEngineData({ jurisdictions, rates, zones, rules }),
    });
    return { engine: manual, engineId: 'manual', registrations: ctx.registrations };
  }
  return { engine: ctx.engine, engineId: ctx.engineId, registrations: ctx.registrations };
}

function toDay(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** The effective combined rate of the part of a line that was taxed. */
function combinedRate(rows: DocumentTaxBreakdownRow[]): string | null {
  const taxed = rows.filter((r) => r.taxableAmount > 0 && r.taxRate > 0);
  if (taxed.length === 0) return rows.length > 0 ? '0.0000' : null;
  return taxed.reduce((sum, r) => sum + r.taxRate, 0).toFixed(4);
}

function totalsFrom(
  items: UsTaxItemInput[],
  lineTotals: Map<string, { net: number; tax: number }>,
  amounts: Map<string, LineAmounts>,
) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    const t = lineTotals.get(item.id) ?? { net: amounts.get(item.id)?.amount ?? 0, tax: 0 };
    subtotal += toCents(t.net);
    taxTotal += toCents(t.tax);
    discountTotal += toCents(amounts.get(item.id)?.discount ?? 0);
  }
  const total = subtotal + taxTotal;
  return {
    subtotal: fromCents(subtotal).toFixed(2),
    discountTotal: fromCents(discountTotal).toFixed(2),
    taxTotal: fromCents(taxTotal).toFixed(2),
    total: fromCents(total).toFixed(2),
    balanceDue: fromCents(total).toFixed(2),
  };
}

/** Totals with no tax: what a draft shows while its engine can't answer. */
export function untaxedTotals(items: UsTaxItemInput[]) {
  const amounts = new Map(items.map((i) => [i.id, lineAmounts(i)]));
  const totals = totalsFrom(items, new Map(), amounts);
  const processedItems = items.map(
    (item): UsProcessedItem => {
      const amount = (amounts.get(item.id)?.amount ?? 0).toFixed(2);
      return {
        id: item.id,
        lineTotal: amount,
        lineTotalWithTax: amount,
        taxAmount: '0.00',
        taxRateId: null,
        taxRate: null,
        taxCode: DEFAULT_WELD_TAX_CODE,
        overridden: false,
      };
    },
  );
  return { ...totals, processedItems };
}

// ---------------------------------------------------------------------------
// Sales: invoices and estimates
// ---------------------------------------------------------------------------

export interface SalesTaxRequestBundle {
  request: SalesTaxRequest;
  taxCodes: Map<string, string>;
  amounts: Map<string, LineAmounts>;
  registrations: SalesTaxRegistration[];
}

async function buildRequest(
  db: Database,
  entity: SalesTaxEntityInfo,
  doc: UsDocumentContext,
  items: UsTaxItemInput[],
  engine: { registrations: SalesTaxRegistration[] },
  direction: 'sales' | 'use',
): Promise<SalesTaxRequestBundle> {
  const products = await loadProducts(db, items.map((i) => i.productId));
  const customer = direction === 'sales' ? await loadCustomer(db, doc.contactId) : {};
  const certificates: ExemptionCertificateRef[] =
    direction === 'sales' && doc.contactId ? await loadCustomerCertificates(db, entity.id, doc.contactId) : [];

  const shipFrom = normalizePostalAddress(doc.shipFromAddress) ?? entity.address ?? {};
  const shipTo =
    direction === 'use'
      ? pickShipTo(doc.deliveryAddress) ?? entity.address
      : pickShipTo(doc.shippingAddress, doc.billingAddress);

  const taxCodes = new Map<string, string>();
  const amounts = new Map<string, LineAmounts>();
  const lines: SalesTaxRequestLine[] = items.map((item) => {
    const code = resolveLineTaxCode(item.taxCode, item.productId ? products.get(item.productId) : undefined);
    taxCodes.set(item.id, code);
    const a = lineAmounts(item);
    amounts.set(item.id, a);
    const overrideAmount = item.taxOverrideAmount !== null && item.taxOverrideAmount !== undefined && item.taxOverrideAmount !== ''
      ? roundCents(num(item.taxOverrideAmount))
      : null;
    return {
      lineId: item.id,
      amount: a.amount,
      quantity: a.quantity,
      taxCode: code,
      use: useOf(item.taxUse) ?? customer.use ?? 'business',
      ...(item.taxIncluded ? { taxIncluded: true } : {}),
      ...(overrideAmount !== null
        ? { override: { amount: overrideAmount, reason: item.taxOverrideReason?.trim() || 'Set by hand' } }
        : {}),
    };
  });

  const request: SalesTaxRequest = {
    entityId: entity.id,
    documentType: doc.kind === 'credit_memo' ? 'credit_memo' : doc.kind === 'estimate' ? 'estimate' : doc.kind === 'bill' ? 'bill' : 'invoice',
    ...(doc.documentId ? { documentId: doc.documentId } : {}),
    ...(doc.documentNumber ? { documentNumber: doc.documentNumber } : {}),
    documentDate: toDay(doc.issueDate),
    currency: doc.currency || entity.baseCurrency,
    shipFrom,
    shipTo,
    customer: { partyId: doc.contactId ?? '', certificates, ...(customer.use ? { use: customer.use } : {}) },
    registrations: engine.registrations,
    lines,
    ...(doc.marketplaceFacilitated ? { marketplaceFacilitated: true } : {}),
    ...(direction === 'use' ? { direction: 'use' as const } : {}),
  };
  return { request, taxCodes, amounts, registrations: engine.registrations };
}

function warningsOf(result: SalesTaxResult): string[] {
  return result.warnings.map(String);
}

/** Rows of one line, from the engine's answer, with the line's totals. */
function summarize(
  items: UsTaxItemInput[],
  result: SalesTaxResult,
  rows: DocumentTaxBreakdownRow[],
  taxCodes: Map<string, string>,
  amounts: Map<string, LineAmounts>,
): { processedItems: UsProcessedItem[]; lineTotals: Map<string, { net: number; tax: number }> } {
  const lineTotals = new Map<string, { net: number; tax: number }>();
  const processedItems = items.map((item): UsProcessedItem => {
    const line = result.lines.find((l) => l.lineId === item.id);
    const lineRows = rows.filter((r) => r.lineId === item.id);
    const net = line ? line.grossAmount : (amounts.get(item.id)?.amount ?? 0);
    const tax = fromCents(lineRows.reduce((sum, r) => sum + toCents(r.taxAmount), 0));
    lineTotals.set(item.id, { net, tax });
    return {
      id: item.id,
      lineTotal: roundCents(net).toFixed(2),
      lineTotalWithTax: roundCents(net + tax).toFixed(2),
      taxAmount: tax.toFixed(2),
      taxRateId: null,
      taxRate: combinedRate(lineRows),
      taxCode: taxCodes.get(item.id) ?? DEFAULT_WELD_TAX_CODE,
      overridden: Boolean(line?.overridden),
    };
  });
  return { processedItems, lineTotals };
}

async function calculateSale(
  db: Database,
  entity: SalesTaxEntityInfo,
  doc: UsDocumentContext,
  items: UsTaxItemInput[],
  runtime: SalesTaxRuntime,
): Promise<UsDocumentTaxCalculation> {
  const ctx = await loadEngine(db, entity.id, runtime, 'sales');
  const bundle = await buildRequest(db, entity, doc, items, ctx, 'sales');
  const result = await ctx.engine.calculate(bundle.request);

  const rows = salesTaxResultToBreakdown(result, {
    lines: items.map((i) => ({ lineId: i.id, taxCode: bundle.taxCodes.get(i.id) })),
    marketplaceFacilitated: Boolean(doc.marketplaceFacilitated),
    registrations: ctx.registrations,
    documentDate: bundle.request.documentDate,
  });
  const { processedItems, lineTotals } = summarize(items, result, rows, bundle.taxCodes, bundle.amounts);
  const totals = totalsFrom(items, lineTotals, bundle.amounts);

  return {
    ...totals,
    taxBreakdown: rows,
    processedItems,
    salesTax: {
      engine: result.engine,
      engineRef: result.engineRef ?? null,
      calculatedAt: new Date(result.calculatedAt),
      warnings: warningsOf(result),
      marketplaceFacilitated: Boolean(doc.marketplaceFacilitated),
      shipToState: result.shipToState ?? null,
      shipToPostalCode: result.shipToPostalCode ?? null,
      addressIncomplete: shipToIncomplete({
        shipTo: bundle.request.shipTo,
        registrations: ctx.registrations,
        lines: bundle.request.lines.map((l) => ({ amount: l.amount, taxCode: String(l.taxCode) })),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Credit memos
// ---------------------------------------------------------------------------

interface OriginalItem {
  id: string;
  description: string;
  unitPrice: string;
  quantity: string | null;
  discountPercent: string | null;
  sortOrder: number | null;
}

/**
 * The invoice line each credit line reverses. The client may name it
 * (`originalLineId`); otherwise a credit line matches the original line with
 * the same description (preferring the same price and position) that no other
 * credit line has taken. A credit memo is created as a copy, so this is exact
 * until the user rewrites a description.
 */
export function mapCreditItemsToOriginal(
  creditItems: Array<{ id: string; description?: string | null; unitPrice: string; sortOrder?: number | null; originalLineId?: string | null }>,
  originalItems: OriginalItem[],
): Map<string, string | null> {
  const taken = new Set<string>();
  const mapping = new Map<string, string | null>();
  const originalIds = new Set(originalItems.map((o) => o.id));

  for (const credit of creditItems) {
    if (credit.originalLineId && originalIds.has(credit.originalLineId)) {
      mapping.set(credit.id, credit.originalLineId);
      taken.add(credit.originalLineId);
    }
  }
  for (const credit of creditItems) {
    if (mapping.has(credit.id)) continue;
    const sameText = originalItems.filter((o) => (o.description ?? '').trim() === (credit.description ?? '').trim());
    const pick =
      sameText.find((o) => !taken.has(o.id) && o.unitPrice === credit.unitPrice && o.sortOrder === (credit.sortOrder ?? null)) ??
      sameText.find((o) => !taken.has(o.id) && o.sortOrder === (credit.sortOrder ?? null)) ??
      sameText.find((o) => !taken.has(o.id) && o.unitPrice === credit.unitPrice) ??
      sameText.find((o) => !taken.has(o.id)) ??
      sameText[0];
    mapping.set(credit.id, pick?.id ?? null);
    if (pick) taken.add(pick.id);
  }
  return mapping;
}

function lineGross(rows: DocumentTaxBreakdownRow[]): number {
  const row = rows[0];
  return row ? row.taxableAmount + (row.exemptAmount ?? 0) + (row.nonTaxableAmount ?? 0) : 0;
}

async function calculateCreditMemo(
  db: Database,
  doc: UsDocumentContext,
  items: UsTaxItemInput[],
): Promise<UsDocumentTaxCalculation> {
  if (!doc.originalInvoiceId) {
    throw new SalesTaxDocumentError(
      'CREDIT_LINE_NOT_ON_ORIGINAL',
      'A credit memo reverses the tax of the invoice it credits. Create it from the invoice (Create credit memo).',
    );
  }
  const [original] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, doc.originalInvoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  const originalItems = original
    ? await db
        .select()
        .from(schema.invoiceItems)
        .where(and(eq(schema.invoiceItems.invoiceId, original.id), isNull(schema.invoiceItems.deletedAt)))
    : [];
  const originalRows = (original?.taxBreakdown ?? []).filter((r) => r.lineId);

  const amounts = new Map(items.map((i) => [i.id, lineAmounts(i)]));
  const mapping = mapCreditItemsToOriginal(items, originalItems);

  const rowsByOriginalLine = new Map<string, DocumentTaxBreakdownRow[]>();
  for (const row of originalRows) {
    const list = rowsByOriginalLine.get(row.lineId as string);
    if (list) list.push(row);
    else rowsByOriginalLine.set(row.lineId as string, [row]);
  }

  // Credit lines of the same original line go in separate batches, so each batch reverses a line once.
  const batches: Array<Array<{ creditId: string; lineId: string; amount: number }>> = [];
  for (const item of items) {
    const originalLineId = mapping.get(item.id);
    if (!originalLineId) {
      // Without an original line there is no tax to reverse. A US invoice credited line by line must say which one.
      if (originalRows.length > 0 || (original && original.taxEngine)) {
        throw new SalesTaxDocumentError(
          'CREDIT_LINE_NOT_ON_ORIGINAL',
          `Credit line "${item.description ?? item.id}" is not a line of the invoice being credited. A credit memo can only credit what was invoiced.`,
          400,
          { lineId: item.id },
        );
      }
      continue;
    }
    const rows = rowsByOriginalLine.get(originalLineId) ?? [];
    if (rows.length === 0) continue;
    const originalItem = originalItems.find((o) => o.id === originalLineId);
    const originalEntered = originalItem
      ? lineAmounts({ id: originalItem.id, quantity: originalItem.quantity, unitPrice: originalItem.unitPrice, discountPercent: originalItem.discountPercent }).amount
      : 0;
    const creditEntered = amounts.get(item.id)?.amount ?? 0;
    const gross = lineGross(rows);
    const amount = originalEntered === 0 ? 0 : roundHalfUp(gross * (creditEntered / originalEntered));
    const batch = batches.find((b) => !b.some((entry) => entry.lineId === originalLineId));
    const entry = { creditId: item.id, lineId: originalLineId, amount };
    if (batch) batch.push(entry);
    else batches.push([entry]);
  }

  const taxBreakdown: DocumentTaxBreakdownRow[] = [];
  for (const batch of batches) {
    const reversed = reverseResultForCreditMemo(
      originalRows,
      batch.map((b) => ({ lineId: b.lineId, amount: b.amount })),
    );
    for (const row of reversed) {
      const credit = batch.find((b) => b.lineId === row.lineId);
      if (credit) taxBreakdown.push({ ...row, lineId: credit.creditId });
    }
  }

  const lineTotals = new Map<string, { net: number; tax: number }>();
  const processedItems = items.map((item): UsProcessedItem => {
    const rows = taxBreakdown.filter((r) => r.lineId === item.id);
    const net = rows.length > 0 ? lineGross(rows) : (amounts.get(item.id)?.amount ?? 0);
    const tax = fromCents(rows.reduce((sum, r) => sum + toCents(r.taxAmount), 0));
    lineTotals.set(item.id, { net, tax });
    return {
      id: item.id,
      lineTotal: roundCents(net).toFixed(2),
      lineTotalWithTax: roundCents(net + tax).toFixed(2),
      taxAmount: tax.toFixed(2),
      taxRateId: null,
      taxRate: combinedRate(rows),
      taxCode: rows[0]?.taxCode ?? DEFAULT_WELD_TAX_CODE,
      overridden: false,
    };
  });
  const totals = totalsFrom(items, lineTotals, amounts);
  const shipTo = original ? pickShipTo(original.shippingAddress, original.billingAddress) : null;

  return {
    ...totals,
    taxBreakdown,
    processedItems,
    salesTax: {
      engine: original?.taxEngine ?? 'manual',
      engineRef: null,
      calculatedAt: new Date(),
      warnings: [],
      marketplaceFacilitated: Boolean(original?.marketplaceFacilitated),
      shipToState: stateCodeOf(shipTo) ?? null,
      shipToPostalCode: zip5Of(shipTo) ?? null,
      addressIncomplete: false,
      originalLineIds: Object.fromEntries(mapping),
    },
  };
}

// ---------------------------------------------------------------------------
// Bills: use tax
// ---------------------------------------------------------------------------

export interface UseTaxAccrual {
  rows: DocumentTaxBreakdownRow[];
  engine: string;
  engineRef: string | null;
  warnings: string[];
}

/**
 * Use tax on the bill lines marked "accrue use tax": the rate at the delivery
 * address, through the entity's engine (Stripe can't do use tax, so those
 * entities use their manual rates). The vendor charged nothing, so none of it
 * is part of the bill total. Zero use tax where no rate is configured is an
 * error: a line marked for accrual never silently accrues nothing.
 */
export async function accrueUseTax(
  db: Database,
  entity: SalesTaxEntityInfo,
  doc: UsDocumentContext,
  items: UsTaxItemInput[],
  lineNets: Map<string, number>,
  runtime: SalesTaxRuntime = NO_CREDENTIALS,
): Promise<UseTaxAccrual | null> {
  const accrued = items.filter((i) => i.accrueUseTax && (lineNets.get(i.id) ?? 0) !== 0);
  if (accrued.length === 0) return null;

  const ctx = await loadEngine(db, entity.id, runtime, 'use');
  const sized = accrued.map((i) => ({
    ...i,
    // The net of the line, as the bill priced it.
    unitPrice: String(lineNets.get(i.id) ?? 0),
    quantity: '1',
    discountPercent: '0',
    taxIncluded: false,
    taxOverrideAmount: null,
  }));
  const bundle = await buildRequest(db, entity, { ...doc, kind: 'bill' }, sized, ctx, 'use');
  const result = await ctx.engine.calculate(bundle.request);
  const warnings = warningsOf(result);

  if (result.totalTax === 0 && warnings.includes('rates_not_configured')) {
    throw new SalesTaxDocumentError(
      'TAX_RATES_NOT_CONFIGURED',
      ctx.engineId === 'manual' && (await entityUsesStripe(db, entity.id))
        ? 'Stripe Tax calculates sales tax only. To accrue use tax, add the state\'s jurisdictions and rates under Sales tax, or switch the engine to Avalara.'
        : 'No sales tax rates are set up for the delivery state, so use tax cannot be accrued. Add its jurisdictions and rates under Sales tax first.',
    );
  }
  const rows = salesTaxResultToBreakdown(result, {
    lines: sized.map((i) => ({ lineId: i.id, taxCode: bundle.taxCodes.get(i.id) })),
    direction: 'use',
    registrations: ctx.registrations,
    documentDate: bundle.request.documentDate,
  });
  return { rows, engine: result.engine, engineRef: result.engineRef ?? null, warnings };
}

async function entityUsesStripe(db: Database, entityId: string): Promise<boolean> {
  const [row] = await db
    .select({ engine: schema.entities.salesTaxEngine })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  return row?.engine === 'stripe_tax';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Tax for an invoice, estimate or credit memo of a sales-tax entity.
 * Throws `SalesTaxEngineError` when the engine can't answer.
 */
export async function calculateUsDocumentTax(
  db: Database,
  args: {
    entity: SalesTaxEntityInfo;
    doc: UsDocumentContext;
    items: UsTaxItemInput[];
    runtime?: SalesTaxRuntime;
  },
): Promise<UsDocumentTaxCalculation> {
  const runtime = args.runtime ?? NO_CREDENTIALS;
  if (args.doc.kind === 'credit_memo') return calculateCreditMemo(db, args.doc, args.items);
  return calculateSale(db, args.entity, args.doc, args.items, runtime);
}

/** The request the engine got for a stored document, for `commit` (provider engines record the finalized document). */
export async function buildStoredRequest(
  db: Database,
  entity: SalesTaxEntityInfo,
  doc: UsDocumentContext,
  items: UsTaxItemInput[],
  runtime: SalesTaxRuntime,
): Promise<{ request: SalesTaxRequest; engine: SalesTaxEngine; engineId: string }> {
  const ctx = await loadEngine(db, entity.id, runtime, 'sales');
  const bundle = await buildRequest(db, entity, doc, items, ctx, 'sales');
  return { request: bundle.request, engine: ctx.engine, engineId: ctx.engineId };
}

export { toRegistration };

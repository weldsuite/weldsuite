import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DocumentTaxBreakdownRow } from '@weldsuite/db/schema';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import {
  calculateLineTaxTotals,
  getEntityStateCode,
  type PlaceOfSupplyContext,
  type TaxTotalsItemInput,
} from './accounting-tax-totals';
import { extractStateCodeFromGstin } from '@weldsuite/books-domain/jurisdictions/in';
import {
  accrueUseTax,
  calculateUsDocumentTax,
  loadSalesTaxEntity,
  untaxedTotals,
  usesSalesTax,
  type UsDocumentContext,
  type UsTaxItemInput,
  type UsTaxMeta,
} from './sales-tax/document-tax';
import type { SalesTaxRuntime } from './sales-tax/runtime';

export class TaxCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxCalculationError';
  }
}

/** Clients send '' or 'none' for "no tax"; both mean no rate. */
export function sanitizeTaxRateId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  return trimmed === '' || trimmed === 'none' || trimmed === 'null' ? null : trimmed;
}

export interface DocumentTaxItem {
  quantity?: string;
  unitPrice: string;
  discountPercent?: string;
  /** Only used when no taxRateId is given (e.g. lines copied from a commerce order). */
  taxRate?: string | null;
  taxRateId?: string | null;

  // US sales tax. The id is the one the line row has (breakdown rows refer to it).
  id?: string;
  description?: string | null;
  sortOrder?: number | null;
  productId?: string | null;
  taxCode?: string | null;
  taxUse?: string | null;
  taxIncluded?: boolean | null;
  taxOverrideAmount?: string | null;
  taxOverrideReason?: string | null;
  accrueUseTax?: boolean | null;
  originalLineId?: string | null;
}

export interface CalculatedLineTax {
  lineTotal: string;
  lineTotalWithTax: string;
  taxAmount: string;
  taxRateId: string | null;
  taxRate: string | null;
  /** US sales tax: the product tax code the line was taxed under. */
  taxCode?: string | null;
}

export interface CalculatedDocumentTax {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  taxBreakdown: DocumentTaxBreakdownRow[];
  processedItems: CalculatedLineTax[];
  /** US sales tax: which engine answered, with its warnings. Absent for VAT / GST entities. */
  salesTax?: UsTaxMeta;
}

/** A US document's totals before any tax: the draft view while the engine is unavailable. */
export function untaxedDocumentTax(items: DocumentTaxItem[]): CalculatedDocumentTax {
  const { processedItems, ...totals } = untaxedTotals(items.map(toUsItem));
  return {
    ...totals,
    taxBreakdown: [],
    processedItems: processedItems.map((p) => ({
      lineTotal: p.lineTotal,
      lineTotalWithTax: p.lineTotalWithTax,
      taxAmount: p.taxAmount,
      taxRateId: null,
      taxRate: null,
    })),
  };
}

function toUsItem(item: DocumentTaxItem, index: number): UsTaxItemInput {
  return {
    id: item.id ?? `line_${index}`,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    discountPercent: item.discountPercent,
    sortOrder: item.sortOrder,
    productId: item.productId,
    taxCode: item.taxCode,
    taxUse: item.taxUse,
    taxIncluded: item.taxIncluded,
    taxOverrideAmount: item.taxOverrideAmount,
    taxOverrideReason: item.taxOverrideReason,
    accrueUseTax: item.accrueUseTax,
    originalLineId: item.originalLineId,
  };
}

/**
 * The one server-side tax calculation for invoices, credit notes, bills and
 * recurring invoices. The client's figures are a preview only.
 *
 * - A line's rate comes from its tax-rate row when it names one (the
 *   client's percentage is ignored), and that row must belong to the entity.
 * - Place of supply (India's CGST/SGST vs IGST) comes from the entity and the
 *   buyer address.
 * - Purchase tax under reverse charge / import categories is marked
 *   self-assessed and left out of the bill total.
 *
 * Entities whose jurisdiction has sales tax (the US) take a different path for
 * sales documents: the entity's sales tax engine answers per line and
 * jurisdiction (services/sales-tax/document-tax). Those callers pass
 * `document`, and `runtime` for provider engines. A US bill keeps the vendor's
 * tax per line (part of the cost) and adds use tax on the lines marked to
 * accrue it.
 */
export async function calculateDocumentTax(
  db: Database,
  args: {
    entityId: string;
    direction: 'sales' | 'purchase';
    items: DocumentTaxItem[];
    buyerCountry?: string;
    buyerStateCode?: string;
    buyerGstin?: string;
    billingProvince?: string;
    document?: UsDocumentContext;
    runtime?: SalesTaxRuntime;
  },
): Promise<CalculatedDocumentTax> {
  const entity = await loadSalesTaxEntity(db, args.entityId);
  const salesTaxEntity = usesSalesTax(entity);

  // A credit memo of an invoice the engine never calculated (booked before the engine existed) keeps its own rates.
  const reusesOriginal =
    args.document?.kind === 'credit_memo' && args.document.originalInvoiceId
      ? await originalWasEngineTaxed(db, args.document.originalInvoiceId)
      : true;

  if (salesTaxEntity && entity && args.direction === 'sales' && reusesOriginal) {
    if (!args.document) throw new TaxCalculationError('A sales tax calculation needs the document context (customer, date, addresses)');
    const calc = await calculateUsDocumentTax(db, {
      entity,
      doc: args.document,
      items: args.items.map(toUsItem),
      runtime: args.runtime,
    });
    const { processedItems, ...rest } = calc;
    return {
      ...rest,
      processedItems: processedItems.map((p) => ({
        lineTotal: p.lineTotal,
        lineTotalWithTax: p.lineTotalWithTax,
        taxAmount: p.taxAmount,
        taxRateId: null,
        taxRate: p.taxRate,
        taxCode: p.taxCode,
      })),
    };
  }

  const legacy = await calculateRateTableTax(db, args);
  if (!salesTaxEntity || !entity || !args.document || !args.items.some((i) => i.accrueUseTax)) return legacy;

  // US bill: use tax on the lines the vendor charged no sales tax on.
  const usItems = args.items.map(toUsItem);
  const lineNets = new Map(usItems.map((item, idx) => [item.id, Number(legacy.processedItems[idx]?.lineTotal ?? 0)]));
  const accrual = await accrueUseTax(db, entity, args.document, usItems, lineNets, args.runtime);
  if (!accrual) return legacy;
  return {
    ...legacy,
    taxBreakdown: [...legacy.taxBreakdown, ...accrual.rows],
    salesTax: {
      engine: accrual.engine,
      engineRef: accrual.engineRef,
      calculatedAt: new Date(),
      warnings: accrual.warnings,
      marketplaceFacilitated: false,
      shipToState: accrual.rows[0]?.stateCode ?? null,
      shipToPostalCode: null,
      addressIncomplete: false,
    },
  };
}

async function originalWasEngineTaxed(db: Database, invoiceId: string): Promise<boolean> {
  const [original] = await db
    .select({ taxEngine: schema.invoices.taxEngine })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);
  return Boolean(original?.taxEngine);
}

/** The rate-table calculation: VAT / GST, and the vendor-charged tax of a US bill. */
async function calculateRateTableTax(
  db: Database,
  args: {
    entityId: string;
    direction: 'sales' | 'purchase';
    items: DocumentTaxItem[];
    buyerCountry?: string;
    buyerStateCode?: string;
    buyerGstin?: string;
    billingProvince?: string;
  },
): Promise<CalculatedDocumentTax> {
  const items = args.items.map((item) => ({ ...item, taxRateId: sanitizeTaxRateId(item.taxRateId) }));
  const rateIds = [...new Set(items.map((i) => i.taxRateId).filter((id): id is string => Boolean(id)))];

  const rateById = new Map<
    string,
    {
      name: string;
      rate: string;
      taxCategoryCode: string | null;
      jurisdictionMetadata: Record<string, unknown> | null;
    }
  >();
  if (rateIds.length > 0) {
    const rates = await db
      .select({
        id: schema.taxRates.id,
        name: schema.taxRates.name,
        rate: schema.taxRates.rate,
        taxCategoryCode: schema.taxRates.taxCategoryCode,
        jurisdictionMetadata: schema.taxRates.jurisdictionMetadata,
      })
      .from(schema.taxRates)
      .where(
        and(
          inArray(schema.taxRates.id, rateIds),
          eq(schema.taxRates.entityId, args.entityId),
          isNull(schema.taxRates.deletedAt),
        ),
      );
    for (const r of rates) {
      rateById.set(r.id, {
        name: r.name,
        rate: r.rate,
        taxCategoryCode: r.taxCategoryCode ?? null,
        jurisdictionMetadata: (r.jurisdictionMetadata as Record<string, unknown> | null) ?? null,
      });
    }
    const missing = rateIds.filter((id) => !rateById.has(id));
    if (missing.length > 0) {
      throw new TaxCalculationError(`Tax rate ${missing.join(', ')} does not belong to this accounting entity`);
    }
  }

  const enriched: TaxTotalsItemInput[] = items.map((item) => {
    const rateRow = item.taxRateId ? rateById.get(item.taxRateId) : undefined;
    return {
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent || '0',
      taxRate: rateRow ? rateRow.rate : (item.taxRate ?? '0'),
      taxRateId: item.taxRateId,
      taxRateName: rateRow?.name ?? null,
      taxCategoryCode: rateRow?.taxCategoryCode ?? null,
      jurisdictionMetadata: rateRow?.jurisdictionMetadata ?? null,
    };
  });

  const place = await loadPlaceOfSupply(db, args.entityId, {
    buyerCountry: args.buyerCountry,
    buyerStateCode: args.buyerStateCode,
    buyerGstin: args.buyerGstin,
    billingProvince: args.billingProvince,
  });
  const totals = calculateLineTaxTotals(enriched, { ...place, direction: args.direction });

  return {
    ...totals,
    processedItems: totals.processedItems.map((processed, idx) => ({
      ...processed,
      taxRateId: enriched[idx].taxRateId ?? null,
      taxRate: enriched[idx].taxRate ?? null,
    })),
  };
}

export async function loadPlaceOfSupply(
  db: Database,
  entityId: string,
  opts?: {
    buyerCountry?: string;
    buyerStateCode?: string;
    buyerGstin?: string;
    billingProvince?: string;
  },
): Promise<PlaceOfSupplyContext> {
  const [entity] = await db
    .select({
      jurisdictionCode: schema.entities.jurisdictionCode,
      taxIdentifiers: schema.entities.taxIdentifiers,
      jurisdictionSettings: schema.entities.jurisdictionSettings,
    })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);

  if (!entity) {
    return { jurisdictionCode: undefined };
  }

  const sellerStateCode = getEntityStateCode(entity);
  let buyerStateCode = opts?.buyerStateCode;
  if (!buyerStateCode && opts?.buyerGstin) {
    buyerStateCode = extractStateCodeFromGstin(opts.buyerGstin);
  }
  // Billing address state/province may carry a 2-digit GST state code for India
  if (!buyerStateCode && opts?.billingProvince && /^\d{2}$/.test(opts.billingProvince)) {
    buyerStateCode = opts.billingProvince;
  }

  return {
    jurisdictionCode: entity.jurisdictionCode,
    sellerStateCode,
    buyerStateCode,
    buyerCountry: opts?.buyerCountry,
  };
}

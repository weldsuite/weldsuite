import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import {
  calculateLineTaxTotals,
  getEntityStateCode,
  type PlaceOfSupplyContext,
  type TaxTotalsItemInput,
} from './accounting-tax-totals';
import { extractStateCodeFromGstin } from '@weldsuite/books-domain/jurisdictions/in';

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
  },
) {
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

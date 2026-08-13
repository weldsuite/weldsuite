import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import {
  calculateLineTaxTotals,
  getEntityStateCode,
  type PlaceOfSupplyContext,
  type TaxTotalsItemInput,
} from './accounting-tax-totals';
import { extractStateCodeFromGstin } from './jurisdictions/in';

/**
 * Load tax-rate rows for the given ids and enrich line inputs with metadata
 * so IN GST slabs can expand into CGST/SGST or IGST.
 */
export async function buildTaxTotalsWithRates(
  db: Database,
  items: Array<{
    quantity?: string;
    unitPrice: string;
    discountPercent?: string;
    taxRate?: string | null;
    taxRateId?: string | null;
  }>,
  place: PlaceOfSupplyContext,
) {
  const rateIds = items.map((i) => i.taxRateId).filter((id): id is string => Boolean(id));
  const rateById = new Map<
    string,
    { name: string; rate: string; jurisdictionMetadata: Record<string, unknown> | null }
  >();

  if (rateIds.length > 0) {
    const rates = await db
      .select({
        id: schema.taxRates.id,
        name: schema.taxRates.name,
        rate: schema.taxRates.rate,
        jurisdictionMetadata: schema.taxRates.jurisdictionMetadata,
      })
      .from(schema.taxRates)
      .where(and(inArray(schema.taxRates.id, rateIds), isNull(schema.taxRates.deletedAt)));

    for (const r of rates) {
      rateById.set(r.id, {
        name: r.name,
        rate: r.rate,
        jurisdictionMetadata: (r.jurisdictionMetadata as Record<string, unknown> | null) ?? null,
      });
    }
  }

  const enriched: TaxTotalsItemInput[] = items.map((item) => {
    const rateRow = item.taxRateId ? rateById.get(item.taxRateId) : undefined;
    return {
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent || '0',
      taxRate: item.taxRate ?? rateRow?.rate ?? '0',
      taxRateId: item.taxRateId ?? null,
      taxRateName: rateRow?.name ?? null,
      jurisdictionMetadata: rateRow?.jurisdictionMetadata ?? null,
    };
  });

  return calculateLineTaxTotals(enriched, place);
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
  // Billing address province may carry a 2-digit GST state code for India
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

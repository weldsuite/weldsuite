import { expandGstTaxBreakdown } from '@weldsuite/books-domain/jurisdictions/in';
import type {
  DocumentTaxContext,
  DocumentTaxLineInput,
  DocumentTaxResult,
} from '@weldsuite/books-domain/jurisdictions/types';

export type TaxBreakdownRow = {
  taxRateId: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  component?: string;
  accountRole?: string;
  taxCategoryCode?: string;
  /** Purchase tax the buyer accounts for itself; not owed to the supplier. */
  selfAssessed?: boolean;
  /** Brazil: added (default) / embedded / withheld / informational; see DocumentTaxBreakdownRow. */
  treatment?: 'added' | 'embedded' | 'withheld' | 'informational';
  offsetAccountRole?: string;
};

export type TaxTotalsItemInput = {
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate?: string | null;
  taxRateId?: string | null;
  taxRateName?: string | null;
  taxCategoryCode?: string | null;
  jurisdictionMetadata?: Record<string, unknown> | null;
  /** Brazil: NCM, CFOP and rate overrides of the line. */
  fiscalData?: Record<string, unknown> | null;
};

/**
 * Purchase tax categories the buyer self-assesses: EU acquisitions and
 * services (NL rubriek 4b), imports (4a) and domestic reverse charge (2a).
 * The supplier charges no tax, so it stays out of the bill total.
 */
const SELF_ASSESSED_PURCHASE_CATEGORIES = new Set(['eu_b2b_service', 'import_goods', 'reverse_charge']);

export type PlaceOfSupplyContext = {
  jurisdictionCode?: string;
  sellerStateCode?: string;
  buyerStateCode?: string;
  buyerCountry?: string;
  /** sales (invoices) use tax_output_*; purchase (bills) use tax_input_* */
  direction?: 'sales' | 'purchase';
};

function parseQuantity(raw: string | undefined): number {
  const parsed = Number.parseFloat(raw ?? '');
  return Number.isFinite(parsed) ? parsed : 1;
}

function parseAmount(raw: string | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(raw ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Round each component to 2 decimals and absorb any remainder into the last
 * row so the component sum equals `targetTax` (also 2-decimal).
 */
function allocateRoundedTax(
  rows: TaxBreakdownRow[],
  targetTax: number,
): TaxBreakdownRow[] {
  if (rows.length === 0) return rows;
  const rounded = rows.map((r) => ({
    ...r,
    taxableAmount: roundMoney(r.taxableAmount),
    taxAmount: roundMoney(r.taxAmount),
  }));
  const sum = rounded.reduce((s, r) => s + r.taxAmount, 0);
  const remainder = roundMoney(targetTax - sum);
  if (Math.abs(remainder) >= 0.01) {
    const last = rounded.at(-1)!;
    last.taxAmount = roundMoney(last.taxAmount + remainder);
  }
  return rounded;
}

/**
 * Compute line totals + tax breakdown. For India (IN) entities with GST slab
 * metadata, expands each line into CGST+SGST or IGST rows based on place of supply.
 */
export function calculateLineTaxTotals(
  items: TaxTotalsItemInput[],
  place?: PlaceOfSupplyContext,
): {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  taxBreakdown: TaxBreakdownRow[];
  processedItems: Array<{ lineTotal: string; lineTotalWithTax: string; taxAmount: string }>;
} {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;

  const breakdownMap = new Map<string, TaxBreakdownRow>();

  const processedItems = items.map((item) => {
    const qty = parseQuantity(item.quantity);
    const price = parseAmount(item.unitPrice, 0);
    const discount = parseAmount(item.discountPercent, 0);
    const rate = parseAmount(item.taxRate ?? undefined, 0);

    const lineGross = qty * price;
    const lineDiscount = lineGross * (discount / 100);
    const lineTotal = roundMoney(lineGross - lineDiscount);
    const targetTax = roundMoney(lineTotal * (rate / 100));

    let rows: TaxBreakdownRow[];

    if (
      place?.jurisdictionCode?.toUpperCase() === 'IN' &&
      item.jurisdictionMetadata &&
      (item.jurisdictionMetadata as { components?: unknown }).components
    ) {
      const expandedRows = expandGstTaxBreakdown({
          taxableAmount: lineTotal,
          taxRateId: item.taxRateId ?? '',
          taxRateName: item.taxRateName ?? `${rate}%`,
          slabRate: rate,
          jurisdictionMetadata: item.jurisdictionMetadata,
          sellerStateCode: place.sellerStateCode,
          buyerStateCode: place.buyerStateCode,
          buyerCountry: place.buyerCountry,
          direction: place.direction ?? 'sales',
      });
      const allocationTarget =
        expandedRows.length > 0 &&
        expandedRows.every((r) => r.component === 'export')
          ? 0
          : targetTax;
      rows = allocateRoundedTax(expandedRows, allocationTarget);
    } else {
      rows = [
        {
          taxRateId: item.taxRateId ?? '',
          taxRateName: item.taxRateName ?? `${rate}%`,
          taxRate: rate,
          taxableAmount: lineTotal,
          taxAmount: targetTax,
        },
      ];
    }

    const selfAssessed =
      place?.direction === 'purchase' &&
      Boolean(item.taxCategoryCode && SELF_ASSESSED_PURCHASE_CATEGORIES.has(item.taxCategoryCode));
    for (const row of rows) {
      if (item.taxCategoryCode) row.taxCategoryCode = item.taxCategoryCode;
      if (selfAssessed) row.selfAssessed = true;
    }

    // Only tax the counterparty actually charges counts toward the document total.
    const lineTax = roundMoney(rows.reduce((sum, r) => sum + (r.selfAssessed ? 0 : r.taxAmount), 0));

    for (const row of rows) {
      const key = `${row.taxRateId}:${row.taxRateName}:${row.taxRate}:${row.component ?? ''}:${row.selfAssessed ? 'sa' : ''}`;
      const existing = breakdownMap.get(key);
      if (existing) {
        existing.taxableAmount = roundMoney(existing.taxableAmount + row.taxableAmount);
        existing.taxAmount = roundMoney(existing.taxAmount + row.taxAmount);
      } else {
        breakdownMap.set(key, { ...row });
      }
    }

    subtotal = roundMoney(subtotal + lineTotal);
    discountTotal = roundMoney(discountTotal + lineDiscount);
    taxTotal = roundMoney(taxTotal + lineTax);

    return {
      lineTotal: lineTotal.toFixed(2),
      lineTotalWithTax: roundMoney(lineTotal + lineTax).toFixed(2),
      taxAmount: lineTax.toFixed(2),
    };
  });

  const taxBreakdown = Array.from(breakdownMap.values());
  const breakdownTaxSum = roundMoney(
    taxBreakdown.reduce((sum, r) => sum + (r.selfAssessed ? 0 : r.taxAmount), 0),
  );
  // Header must match both processed line taxes and breakdown (already allocated per line)
  const reconciledTaxTotal = taxBreakdown.length > 0 ? breakdownTaxSum : taxTotal;

  return {
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    taxTotal: reconciledTaxTotal.toFixed(2),
    total: roundMoney(subtotal + reconciledTaxTotal).toFixed(2),
    balanceDue: roundMoney(subtotal + reconciledTaxTotal).toFixed(2),
    taxBreakdown,
    processedItems,
  };
}

/** Read Indian state code from entity jurisdictionSettings or GSTIN. */
export function getEntityStateCode(entity: {
  taxIdentifiers?: { vatNumber?: string } | null;
  jurisdictionSettings?: Record<string, unknown> | null;
}): string | undefined {
  const fromSettings = entity.jurisdictionSettings?.stateCode;
  if (typeof fromSettings === 'string' && /^\d{2}$/.test(fromSettings.trim())) {
    return fromSettings.trim();
  }
  const gstin = entity.taxIdentifiers?.vatNumber;
  if (gstin) {
    const normalized = gstin.replace(/[\s-]/g, '').toUpperCase();
    const match = /^\d{2}/.exec(normalized);
    return match?.[0];
  }
  return undefined;
}

/** What a row does to the document total: + added, - withheld, 0 embedded / informational / self-assessed. */
function totalEffect(row: TaxBreakdownRow): number {
  if (row.selfAssessed) return 0;
  if (row.treatment === 'withheld') return -row.taxAmount;
  if (row.treatment === 'embedded' || row.treatment === 'informational') return 0;
  return row.taxAmount;
}

function breakdownKey(row: TaxBreakdownRow): string {
  return `${row.taxRateId}:${row.taxRateName}:${row.taxRate}:${row.component ?? ''}:${row.treatment ?? ''}:${row.selfAssessed ? 'sa' : ''}`;
}

/**
 * Totals of a document whose jurisdiction calculates the whole document at
 * once (Brazil). Lines carry the taxes on top of their price (IPI, later
 * CBS/IBS); taxes inside the price are in the breakdown but leave the total
 * alone; withholdings come off the total, so `total` is what the counterparty
 * owes and `taxTotal` = added - withheld (it can be negative).
 */
export function calculateHookTaxTotals(
  items: TaxTotalsItemInput[],
  compute: (lines: DocumentTaxLineInput[], ctx: DocumentTaxContext) => DocumentTaxResult,
  ctx: DocumentTaxContext,
): {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  taxBreakdown: TaxBreakdownRow[];
  processedItems: Array<{ lineTotal: string; lineTotalWithTax: string; taxAmount: string }>;
  taxWarnings: string[];
} {
  let subtotal = 0;
  let discountTotal = 0;
  const inputs: DocumentTaxLineInput[] = items.map((item) => {
    const qty = parseQuantity(item.quantity);
    const price = parseAmount(item.unitPrice, 0);
    const discount = parseAmount(item.discountPercent, 0);
    const lineGross = qty * price;
    const lineDiscount = lineGross * (discount / 100);
    const lineTotal = roundMoney(lineGross - lineDiscount);
    subtotal = roundMoney(subtotal + lineTotal);
    discountTotal = roundMoney(discountTotal + lineDiscount);
    return {
      lineTotal,
      taxRateId: item.taxRateId ?? null,
      taxRateName: item.taxRateName ?? null,
      taxCategoryCode: item.taxCategoryCode ?? null,
      rate: parseAmount(item.taxRate ?? undefined, 0),
      jurisdictionMetadata: item.jurisdictionMetadata ?? null,
      fiscalData: item.fiscalData ?? null,
    };
  });

  const result = compute(inputs, ctx);
  const breakdownMap = new Map<string, TaxBreakdownRow>();
  const add = (row: TaxBreakdownRow) => {
    const key = breakdownKey(row);
    const existing = breakdownMap.get(key);
    if (existing) {
      existing.taxableAmount = roundMoney(existing.taxableAmount + row.taxableAmount);
      existing.taxAmount = roundMoney(existing.taxAmount + row.taxAmount);
    } else {
      breakdownMap.set(key, { ...row });
    }
  };

  const processedItems = inputs.map((input, idx) => {
    const rows = (result.lines[idx]?.rows ?? []) as TaxBreakdownRow[];
    rows.forEach(add);
    const lineTax = roundMoney(rows.reduce((sum, r) => sum + Math.max(0, totalEffect(r)), 0));
    return {
      lineTotal: input.lineTotal.toFixed(2),
      lineTotalWithTax: roundMoney(input.lineTotal + lineTax).toFixed(2),
      taxAmount: lineTax.toFixed(2),
    };
  });
  for (const row of result.documentRows as TaxBreakdownRow[]) add(row);

  const taxBreakdown = Array.from(breakdownMap.values());
  const taxTotal = roundMoney(taxBreakdown.reduce((sum, r) => sum + totalEffect(r), 0));
  const total = roundMoney(subtotal + taxTotal);
  return {
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: total.toFixed(2),
    balanceDue: total.toFixed(2),
    taxBreakdown,
    processedItems,
    taxWarnings: result.warnings,
  };
}

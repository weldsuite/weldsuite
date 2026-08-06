import { expandGstTaxBreakdown } from './jurisdictions/in';

export type TaxBreakdownRow = {
  taxRateId: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  component?: string;
  accountRole?: string;
};

export type TaxTotalsItemInput = {
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate?: string | null;
  taxRateId?: string | null;
  taxRateName?: string | null;
  jurisdictionMetadata?: Record<string, unknown> | null;
};

export type PlaceOfSupplyContext = {
  jurisdictionCode?: string;
  sellerStateCode?: string;
  buyerStateCode?: string;
  buyerCountry?: string;
  /** sales (invoices) use tax_output_*; purchase (bills) use tax_input_* */
  direction?: 'sales' | 'purchase';
};

function parseQuantity(raw: string | undefined): number {
  const parsed = parseFloat(raw ?? '');
  return Number.isFinite(parsed) ? parsed : 1;
}

function parseAmount(raw: string | undefined, fallback = 0): number {
  const parsed = parseFloat(raw ?? '');
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
    const last = rounded[rounded.length - 1];
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
      rows = allocateRoundedTax(
        expandGstTaxBreakdown({
          taxableAmount: lineTotal,
          taxRateId: item.taxRateId ?? '',
          taxRateName: item.taxRateName ?? `${rate}%`,
          slabRate: rate,
          jurisdictionMetadata: item.jurisdictionMetadata,
          sellerStateCode: place.sellerStateCode,
          buyerStateCode: place.buyerStateCode,
          buyerCountry: place.buyerCountry,
          direction: place.direction ?? 'sales',
        }),
        targetTax,
      );
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

    const lineTax = roundMoney(rows.reduce((sum, r) => sum + r.taxAmount, 0));

    for (const row of rows) {
      const key = `${row.taxRateId}:${row.taxRateName}:${row.taxRate}:${row.component ?? ''}`;
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
  const breakdownTaxSum = roundMoney(taxBreakdown.reduce((sum, r) => sum + r.taxAmount, 0));
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
  if (typeof fromSettings === 'string' && /^[0-9]{2}$/.test(fromSettings.trim())) {
    return fromSettings.trim();
  }
  const gstin = entity.taxIdentifiers?.vatNumber;
  if (gstin) {
    const normalized = gstin.replace(/[\s-]/g, '').toUpperCase();
    const match = normalized.match(/^[0-9]{2}/);
    return match?.[0];
  }
  return undefined;
}

/**
 * Purchase order amounts, worked out for display.
 *
 * The server computes every line's amounts and the header totals (the Rust
 * backend after each line change and on approve and receive). The screens
 * show totals summed from the lines, so they are right even where the header
 * was not recomputed (Global's header is not). Whole cents throughout, like
 * the server: each step rounds half up.
 *
 * The rules, as the plan states them:
 * - line total = quantity x unit price, less the discount percentage, plus
 *   tax on what is left;
 * - header `subtotal` = sum of (line total - line tax), `taxTotal` = sum of
 *   line tax, `total` = subtotal + tax + shipping - discount.
 */

import { toNumber } from '../../lib/numbers';

const toCents = (amount: number) => Math.round(amount * 100);
const fromCents = (cents: number) => cents / 100;

export interface LineFigures {
  quantityOrdered: number;
  unitPrice: number;
  discountPercent: number;
  taxPercent: number;
}

export interface LineAmounts {
  gross: number;
  discountAmount: number;
  taxAmount: number;
  /** Net of discount, plus tax. */
  total: number;
}

/** The amounts of a line before it is saved, for the line form's preview. */
export function previewLineAmounts(line: LineFigures): LineAmounts {
  const gross = line.quantityOrdered * toCents(line.unitPrice);
  const discount = Math.round((gross * line.discountPercent) / 100);
  const net = gross - discount;
  const tax = Math.round((net * line.taxPercent) / 100);
  return {
    gross: fromCents(gross),
    discountAmount: fromCents(discount),
    taxAmount: fromCents(tax),
    total: fromCents(net + tax),
  };
}

/** A saved line, as the API returns it (numeric columns as text). */
export interface SavedLineFigures {
  quantityOrdered: number;
  quantityReceived?: number | null;
  total: string | number | null;
  taxAmount?: string | number | null;
}

export interface PurchaseOrderTotals {
  itemCount: number;
  totalQuantityOrdered: number;
  totalQuantityReceived: number;
  subtotal: number;
  taxTotal: number;
  shippingTotal: number;
  discountTotal: number;
  total: number;
}

/** Header totals from the lines and the header's shipping and discount. */
export function computePurchaseOrderTotals(
  lines: readonly SavedLineFigures[],
  header: { shippingTotal?: string | number | null; discountTotal?: string | number | null } = {},
): PurchaseOrderTotals {
  let taxCents = 0;
  let subtotalCents = 0;
  let ordered = 0;
  let received = 0;
  for (const line of lines) {
    const lineTotal = toCents(toNumber(line.total));
    const lineTax = toCents(toNumber(line.taxAmount));
    taxCents += lineTax;
    subtotalCents += lineTotal - lineTax;
    ordered += line.quantityOrdered;
    received += toNumber(line.quantityReceived);
  }
  const shippingCents = toCents(toNumber(header.shippingTotal));
  const discountCents = toCents(toNumber(header.discountTotal));
  return {
    itemCount: lines.length,
    totalQuantityOrdered: ordered,
    totalQuantityReceived: received,
    subtotal: fromCents(subtotalCents),
    taxTotal: fromCents(taxCents),
    shippingTotal: fromCents(shippingCents),
    discountTotal: fromCents(discountCents),
    total: fromCents(subtotalCents + taxCents + shippingCents - discountCents),
  };
}

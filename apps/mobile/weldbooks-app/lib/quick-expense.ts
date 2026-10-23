/**
 * Quick expense amounts.
 *
 * A receipt shows what was paid, VAT included, so that is what the quick
 * expense form takes. books-api prices bill lines excluding tax and rounds each
 * line's tax to the cent (`calculateLineTaxTotals`), so the net price is solved
 * for here: the line whose net plus rounded VAT lands on the total. Some totals
 * cannot be reached by any net price at a given rate; the cent left over is
 * booked as a separate untaxed rounding line, so the bill always equals the
 * receipt.
 */

import { parseAmount } from '@/lib/currency';
import type { LineItemInput } from '@/lib/line-items';
import type { BillPrefill } from '@/types/accounting';

/** Rounding gaps above this are an OCR misread, not rounding, and are not papered over. */
const MAX_ROUNDING = 0.05;

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** VAT on a net amount in cents, rounded like books-api rounds a line. */
function taxCents(netCents: number, rate: number): number {
  return Math.round((netCents * rate) / 100);
}

/** The net price of `total` (VAT included) at `rate`, and the rounding that is left. */
export function splitInclusiveTotal(total: number, rate: number): { net: number; tax: number; rounding: number } {
  const totalCents = toCents(total);
  if (!Number.isFinite(rate) || rate <= 0) return { net: totalCents / 100, tax: 0, rounding: 0 };

  const guess = Math.round(totalCents / (1 + rate / 100));
  let best = guess;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let net = guess - 2; net <= guess + 2; net++) {
    const gap = Math.abs(totalCents - (net + taxCents(net, rate)));
    if (gap < bestGap) {
      best = net;
      bestGap = gap;
    }
  }
  const tax = taxCents(best, rate);
  return { net: best / 100, tax: tax / 100, rounding: (totalCents - best - tax) / 100 };
}

/** The distinct VAT rates on a receipt's lines, lowest first. */
export function prefillTaxRates(prefill: BillPrefill): number[] {
  const rates = new Set<number>();
  for (const item of prefill.items) {
    if (item.taxRate != null && item.taxRate !== '') rates.add(parseAmount(item.taxRate));
  }
  return [...rates].sort((a, b) => a - b);
}

/** What the receipt lines add up to, VAT included and rounded per line. */
export function prefillLinesTotal(prefill: BillPrefill): number {
  const cents = prefill.items.reduce((sum, item) => {
    const net = toCents(parseAmount(item.quantity || '1') * parseAmount(item.unitPrice || '0'));
    return sum + net + taxCents(net, parseAmount(item.taxRate || '0'));
  }, 0);
  return cents / 100;
}

/**
 * The total to prefill: the receipt's own total, else what its lines add up
 * to. A US receipt's total already holds the sales tax that is part of the cost.
 */
export function totalFromPrefill(prefill: BillPrefill): number | null {
  if (prefill.total != null && prefill.total > 0) return prefill.total;
  const fromLines = prefillLinesTotal(prefill);
  if (fromLines > 0) return fromLines;
  return prefill.subtotal != null && prefill.subtotal > 0 ? prefill.subtotal : null;
}

export interface QuickExpenseLinesInput {
  /** What was paid, VAT included. */
  total: number;
  taxRate: number;
  description: string;
  roundingDescription: string;
  accountId?: string;
  /**
   * The receipt's own lines, kept when they carry more than one VAT rate: one
   * rate on the whole total would book the wrong VAT. Used only while they add
   * up to `total`.
   */
  receiptLines?: BillPrefill['items'];
}

function roundingLine(cents: number, description: string): LineItemInput[] {
  if (cents === 0 || Math.abs(cents) > toCents(MAX_ROUNDING)) return [];
  return [{ description, quantity: 1, unitPrice: cents / 100, taxRate: 0 }];
}

/**
 * The receipt's lines plus the rounding left to `total`, or null when they
 * miss it by more than rounding: OCR left a line out (a discount, a deposit),
 * and booking them would charge another amount than the one confirmed.
 */
function receiptBillLines(input: QuickExpenseLinesInput, items: BillPrefill['items']): LineItemInput[] | null {
  const gap = toCents(input.total) - toCents(prefillLinesTotal({ items } as BillPrefill));
  if (Math.abs(gap) > toCents(MAX_ROUNDING)) return null;
  const lines: LineItemInput[] = items.map((item) => ({
    description: item.description || input.description,
    quantity: item.quantity || '1',
    unitPrice: item.unitPrice || '0',
    taxRate: item.taxRate ?? 0,
    accountId: input.accountId,
  }));
  return [...lines, ...roundingLine(gap, input.roundingDescription)];
}

/** The bill lines of a quick expense, adding up to `total`. */
export function quickExpenseLines(input: QuickExpenseLinesInput): LineItemInput[] {
  const fromReceipt = input.receiptLines?.length ? receiptBillLines(input, input.receiptLines) : null;
  if (fromReceipt) return fromReceipt;

  const { net, rounding } = splitInclusiveTotal(input.total, input.taxRate);
  return [
    {
      description: input.description,
      quantity: 1,
      unitPrice: net,
      taxRate: input.taxRate,
      accountId: input.accountId,
    },
    ...roundingLine(toCents(rounding), input.roundingDescription),
  ];
}

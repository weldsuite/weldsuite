/**
 * Line-item drafts shared by the invoice and bill forms, and how they become
 * the payload app-api takes.
 *
 * Amounts are edited as text and only parsed on submit — typing "12." must not
 * be normalised out from under the cursor. `parseAmount` handles both European
 * and US decimal separators.
 *
 * How a line is taxed depends on the entity's jurisdiction:
 *  - `rate`: VAT / GST. The user picks a percentage per line (NL 21, IN 18).
 *  - `code`: US invoice. The line carries a product tax code (saas, clothing,
 *    shipping, ...) and books-api works out the tax per jurisdiction from the
 *    ship-to address. The app never sends a rate, so a stale percentage can't
 *    override the engine.
 *  - `cost`: US bill. Sales tax a vendor charged is part of what the item cost
 *    (a percentage the user enters, 0 by default); where the vendor charged
 *    none, the line can accrue use tax, which books-api rates by the line's
 *    tax code and the delivery address.
 */

import { parseAmount } from '@/lib/currency';
import { DEFAULT_TAX_CODE } from '@/lib/us';

export type LineItemTaxMode = 'rate' | 'code' | 'cost';

export interface LineItemDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  /** Percentage text: the line's VAT / GST (`rate`) or the sales tax the vendor charged (`cost`). */
  taxRate: string;
  /** US: product tax code. */
  taxCode: string;
  /** US bill: the vendor charged no sales tax, so accrue use tax. */
  accrueUseTax: boolean;
}

/** A line as `services/api.ts` sends it. */
export interface LineItemInput {
  description: string;
  quantity?: number | string;
  unitPrice: number | string;
  taxRateId?: string;
  taxRate?: number | string;
  /** US: product tax code. */
  taxCode?: string;
  /** US bill: accrue use tax on this line. */
  accrueUseTax?: boolean;
  accountId?: string;
  sortOrder?: number;
}

let keyCounter = 0;

/** A fresh, blank line. `taxRate` is the jurisdiction's default percentage (ignored in `code` mode). */
export function createEmptyLineItem(defaults: { taxRate?: string } = {}): LineItemDraft {
  keyCounter += 1;
  return {
    key: `li_${Date.now().toString(36)}_${keyCounter}`,
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: defaults.taxRate ?? '0',
    taxCode: DEFAULT_TAX_CODE,
    accrueUseTax: false,
  };
}

export interface LineItemTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

export function lineTotal(item: LineItemDraft): number {
  return parseAmount(item.quantity || '0') * parseAmount(item.unitPrice || '0');
}

/**
 * Subtotal, tax and total of the drafts.
 *
 * In `code` mode the tax is the server's to calculate, so it is 0 here: the
 * invoice form shows the engine's figures (`POST /sales-tax/calculate`) once it
 * has them rather than a number that can't match.
 */
export function calculateTotals(items: LineItemDraft[], mode: LineItemTaxMode = 'rate'): LineItemTotals {
  let subtotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    const total = lineTotal(item);
    subtotal += total;
    if (mode !== 'code') taxTotal += total * (parseAmount(item.taxRate || '0') / 100);
  }
  return { subtotal, taxTotal, total: subtotal + taxTotal };
}

/** Items that have both a description and a non-zero price. */
export function validLineItems(items: LineItemDraft[]): LineItemDraft[] {
  return items.filter(
    (item) => item.description.trim() !== '' && parseAmount(item.unitPrice || '0') > 0,
  );
}

/** The valid drafts as the API payload for the entity's tax mode. */
export function toLineItemInputs(items: LineItemDraft[], mode: LineItemTaxMode): LineItemInput[] {
  return validLineItems(items).map((item, index) => {
    const base: LineItemInput = {
      description: item.description.trim(),
      quantity: parseAmount(item.quantity || '1'),
      unitPrice: parseAmount(item.unitPrice),
      sortOrder: index,
    };
    if (mode === 'rate') return { ...base, taxRate: parseAmount(item.taxRate || '0') };
    if (mode === 'code') return { ...base, taxCode: item.taxCode || DEFAULT_TAX_CODE };
    return {
      ...base,
      taxRate: parseAmount(item.taxRate || '0'),
      ...(item.accrueUseTax ? { accrueUseTax: true, taxCode: item.taxCode || DEFAULT_TAX_CODE } : {}),
    };
  });
}

/** Which tax mode a document form uses: sales tax by code (US invoice), vendor tax as cost (US bill), else a rate. */
export function lineItemTaxMode(isUs: boolean, kind: 'invoice' | 'bill'): LineItemTaxMode {
  if (!isUs) return 'rate';
  return kind === 'invoice' ? 'code' : 'cost';
}

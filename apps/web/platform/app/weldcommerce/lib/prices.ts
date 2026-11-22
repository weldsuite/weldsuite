/**
 * A product's prices per currency in the UI: the rows being edited, their
 * validation and the conversion to the `PUT /products/:id/prices` body, which
 * replaces the product's whole set.
 */

import type { ProductPrice, ProductPriceInput } from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import { parsePriceInput } from './variants';

/** One row of the price editor: a price of the product (`variantId` null) or of a variant, in one currency. */
export interface PriceEntry {
  /** Stable for the row's life, so React keeps its inputs while the list changes. */
  key: string;
  variantId: string | null;
  currency: string;
  price: string;
  compareAtPrice: string;
}

export interface PriceEntryErrors {
  currency?: string;
  price?: string;
  compareAtPrice?: string;
}

export function entriesFromPrices(prices: readonly ProductPrice[]): PriceEntry[] {
  return prices.map((p) => ({
    key: p.id,
    variantId: p.variantId,
    currency: p.currency,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? '',
  }));
}

export function newPriceEntry(key: string, variantId: string | null): PriceEntry {
  return { key, variantId, currency: '', price: '', compareAtPrice: '' };
}

/** The key of the entry in its own subject's list: the same subject and currency may not repeat. */
function slot(entry: PriceEntry): string {
  return `${entry.variantId ?? ''}|${entry.currency.trim().toUpperCase()}`;
}

function checkEntry(entry: PriceEntry, baseCurrency: string | null | undefined, taken: Set<string>): PriceEntryErrors {
  const t = getTranslations('commerce').prices.errors;
  const errors: PriceEntryErrors = {};
  const currency = entry.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = t.currency;
  else if (taken.has(slot(entry))) errors.currency = t.duplicate;
  else if (entry.variantId === null && currency === baseCurrency?.toUpperCase()) errors.currency = t.baseCurrency;

  const price = parsePriceInput(entry.price);
  if (price === null || price === undefined) errors.price = t.price;
  // A compare-at price is optional; when given it is a price too.
  if (entry.compareAtPrice.trim() !== '' && parsePriceInput(entry.compareAtPrice) === undefined) {
    errors.compareAtPrice = t.compareAt;
  }
  return errors;
}

/** The problems per row key; an empty object when the whole set can be saved. */
export function validateEntries(
  entries: readonly PriceEntry[],
  baseCurrency: string | null | undefined,
): Record<string, PriceEntryErrors> {
  const result: Record<string, PriceEntryErrors> = {};
  const taken = new Set<string>();
  for (const entry of entries) {
    const errors = checkEntry(entry, baseCurrency, taken);
    taken.add(slot(entry));
    if (Object.keys(errors).length > 0) result[entry.key] = errors;
  }
  return result;
}

/** A price as the API takes it: two decimals. */
function toMoney(value: string): string {
  return Number(parsePriceInput(value) ?? '0').toFixed(2);
}

export function toPriceInputs(entries: readonly PriceEntry[]): ProductPriceInput[] {
  return entries.map((entry) => ({
    variantId: entry.variantId,
    currency: entry.currency.trim().toUpperCase(),
    price: toMoney(entry.price),
    compareAtPrice: entry.compareAtPrice.trim() === '' ? null : toMoney(entry.compareAtPrice),
  }));
}

/** Whether two sets of rows say the same thing, whatever their keys. */
export function sameEntries(a: readonly PriceEntry[], b: readonly PriceEntry[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (list: readonly PriceEntry[]) =>
    list
      .map((e) => `${slot(e)}|${e.price.trim()}|${e.compareAtPrice.trim()}`)
      .sort((x, y) => x.localeCompare(y))
      .join(';');
  return norm(a) === norm(b);
}

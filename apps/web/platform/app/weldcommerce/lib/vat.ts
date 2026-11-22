/**
 * VAT in words: a product's category, the way an order's VAT was worked out,
 * and a rate. The strings are the `commerce` namespace's.
 */

import { getTranslations } from '@/lib/i18n';
import type { VatCategory } from '@/hooks/queries/use-commerce-queries';
import type { VatTreatment } from '@/hooks/queries/use-commerce-orders-queries';
import { fill } from './text';

export const VAT_CATEGORIES: readonly VatCategory[] = ['standard', 'reduced', 'super_reduced', 'zero', 'exempt'];

export function isVatCategory(value: string | null | undefined): value is VatCategory {
  return (VAT_CATEGORIES as readonly (string | null | undefined)[]).includes(value);
}

/** A category's name; an unknown one is shown as it came. */
export function vatCategoryLabel(category: string | null | undefined): string {
  const t = getTranslations('commerce').products.vat;
  switch (category) {
    case 'standard':
      return t.standard;
    case 'reduced':
      return t.reduced;
    case 'super_reduced':
      return t.superReduced;
    case 'zero':
      return t.zero;
    case 'exempt':
      return t.exempt;
    default:
      return category ?? '—';
  }
}

/** `"21.00"` as `21`, `"5.50"` as `5.5`: a rate to print before a percent sign. */
export function rateText(rate: string | number | null | undefined): string {
  const n = rate === null || rate === undefined || rate === '' ? Number.NaN : Number(rate);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : '—';
}

/** How the VAT of an order was worked out, as a sentence; null when no VAT was calculated. */
export function vatTreatmentText(treatment: VatTreatment | null | undefined, country: string | null | undefined): string | null {
  if (!treatment) return null;
  const known: Record<string, string> = getTranslations('commerce').orders.panel.vat.treatment;
  const sentence = known[treatment];
  return sentence ? fill(sentence, { country: country ?? '' }) : treatment;
}

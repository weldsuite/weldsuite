/**
 * Variant helpers: the option matrix behind "Generate variants" and how a
 * variant reads in a list.
 */

import type { CommerceVariant, VariantOption } from '@/hooks/queries/use-commerce-queries';

/** The server generates at most this many options and combinations. */
export const MAX_OPTIONS = 3;
export const MAX_COMBINATIONS = 100;

/** The statuses a variant can have; the first is what a new variant gets. */
export const VARIANT_STATUSES = ['active', 'draft', 'inactive'] as const;

/**
 * The options behind a product's variants. The product's own `options` come
 * first, in the seller's order (the server keeps them in step with the
 * variants); whatever the variants use beyond them follows, read back from the
 * variants by position. A variant's `optionValues` alone can't give the order:
 * its keys come back sorted.
 */
export function deriveOptions(
  variants: readonly CommerceVariant[],
  productOptions?: readonly { name: string; values: readonly string[] }[] | null,
): VariantOption[] {
  const sorted = [...variants].sort((a, b) => a.position - b.position);
  const options = new Map<string, string[]>();
  for (const option of productOptions ?? []) {
    if (option.name) options.set(option.name, [...option.values]);
  }
  for (const variant of sorted) {
    for (const [name, value] of Object.entries(variant.optionValues ?? {})) {
      const values = options.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      options.set(name, values);
    }
  }
  return [...options].map(([name, values]) => ({ name, values }));
}

/**
 * The options as they are sent: names and values trimmed, blanks and repeated
 * values dropped, options without a name or a value left out.
 */
export function cleanOptions(options: readonly VariantOption[]): VariantOption[] {
  return options
    .map((option) => {
      const values: string[] = [];
      for (const raw of option.values) {
        const value = raw.trim();
        if (value && !values.includes(value)) values.push(value);
      }
      return { name: option.name.trim(), values };
    })
    .filter((option) => option.name && option.values.length > 0);
}

/** How many variants the options make: the product of their value counts, 0 without options. */
export function combinationCount(options: readonly VariantOption[]): number {
  if (options.length === 0) return 0;
  return options.reduce((total, option) => total * option.values.length, 1);
}

/** Two options with the same name (case-insensitive) would collide in `optionValues`. */
export function hasDuplicateNames(options: readonly VariantOption[]): boolean {
  const names = options.map((option) => option.name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size !== names.length;
}

/**
 * "L / Red": the variant's name (the server writes its option values in the
 * product's option order), else its option values; null without either.
 */
export function variantTitle(variant: Pick<CommerceVariant, 'optionValues' | 'name'>): string | null {
  if (variant.name?.trim()) return variant.name.trim();
  const values = Object.values(variant.optionValues ?? {}).filter(Boolean);
  return values.length > 0 ? values.join(' / ') : null;
}

/**
 * A price as typed, as the API takes it: a decimal string with at most two
 * decimals, comma or point; blank is null (the product's price). Undefined
 * when it is not a price.
 */
export function parsePriceInput(input: string): string | null | undefined {
  const value = input.trim().replace(',', '.');
  if (!value) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  return value;
}

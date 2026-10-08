/**
 * WeldBooks product tax codes (US sales tax). Mirrors `WELD_TAX_CODES` in
 * `@weldsuite/books-domain/jurisdictions/us/tax-codes` (the platform doesn't
 * import the domain package). Products keep a code in `products.tax_class`;
 * invoice and bill lines carry their own `tax_code`. The labels are
 * translated (`weldbooksUs.salesTax.documents.taxCodes`).
 */

export const WELD_TAX_CODES = [
  'general',
  'saas',
  'digital_goods',
  'services',
  'professional_services',
  'shipping',
  'handling',
  'food_grocery',
  'prepared_food',
  'clothing',
  'prescription_drugs',
  'non_taxable',
] as const;

export type WeldTaxCode = (typeof WELD_TAX_CODES)[number];

/** The code a line gets when it has none and its product has none: taxable as general goods. */
export const DEFAULT_WELD_TAX_CODE: WeldTaxCode = 'general';

export function isWeldTaxCode(value: unknown): value is WeldTaxCode {
  return typeof value === 'string' && (WELD_TAX_CODES as readonly string[]).includes(value);
}

/** The tax fields of a catalogue product (`products.tax_class`, `products.taxable`). */
export interface ProductTaxFields {
  taxClass?: string | null;
  taxable?: boolean | null;
}

/**
 * The tax code a product gives a line: its own code when it is a WeldBooks
 * one, `non_taxable` for a product marked not taxable, null when the product
 * says nothing usable (older products carry values such as `standard`).
 * Same rule as the server's order-to-invoice conversion.
 */
export function productTaxCode(product: ProductTaxFields | null | undefined): WeldTaxCode | null {
  if (!product) return null;
  if (product.taxable === false) return 'non_taxable';
  return isWeldTaxCode(product.taxClass) ? product.taxClass : null;
}

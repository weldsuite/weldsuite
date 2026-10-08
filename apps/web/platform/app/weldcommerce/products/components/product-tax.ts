/**
 * The "Sales tax" section of the product form: what a product stores
 * (`products.taxable`, `products.tax_class`) and how the form edits it.
 *
 * `taxClass` is a WeldBooks tax code (`general`, `saas`, ...) or, for a product
 * the short list does not describe, a Stripe Tax code (`txcd_20030000`) or an
 * Avalara code (`SW054000`). commerce-api accepts the same three shapes and
 * refuses anything else, so the custom input is checked here first.
 *
 * Older products may hold a word that is no tax code at all (`standard`). The
 * form shows those as the default and leaves them alone until the person
 * touches the tax code; the readers fall back to `general` for them anyway.
 */

import { isWeldTaxCode, type WeldTaxCode } from '@/lib/weldbooks/tax-codes';

/** Select value for "no code": the product is taxed as general goods. */
export const TAX_CODE_DEFAULT = '__default__';
/** Select value for a provider code typed by hand. */
export const TAX_CODE_CUSTOM = '__custom__';

export type TaxCodeChoice = typeof TAX_CODE_DEFAULT | typeof TAX_CODE_CUSTOM | WeldTaxCode;

/** What the product holds today. */
export interface StoredProductTax {
  taxable: boolean;
  taxClass: string | null;
}

/** What the form holds. */
export interface ProductTaxState {
  taxable: boolean;
  choice: TaxCodeChoice;
  /** The text of the custom input; only read while `choice` is custom. */
  custom: string;
  /** The person changed the tax code: an untouched legacy value is never overwritten. */
  touched: boolean;
}

export interface ProductTaxPayload {
  taxable?: boolean;
  taxClass?: string | null;
}

const STRIPE_CODE = /^txcd_\d{8}$/;
const AVALARA_CODE = /^[A-Z]{1,2}\d{6,7}$/;

/** `txcd_` codes are lower case, Avalara codes upper case; a person typing either should not have to care. */
export function normalizeProviderTaxCode(input: string): string {
  const trimmed = input.trim();
  return trimmed.toLowerCase().startsWith('txcd_') ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

export function isProviderTaxCode(value: string): boolean {
  return STRIPE_CODE.test(value) || AVALARA_CODE.test(value);
}

export function storedProductTax(
  product?: { taxable?: boolean | null; taxClass?: string | null } | null,
): StoredProductTax {
  const taxClass = product?.taxClass?.trim();
  return { taxable: product?.taxable !== false, taxClass: taxClass ? taxClass : null };
}

export function initialTaxState(stored: StoredProductTax): ProductTaxState {
  const { taxable, taxClass } = stored;
  if (taxClass !== null && isWeldTaxCode(taxClass)) {
    return { taxable, choice: taxClass, custom: '', touched: false };
  }
  if (taxClass !== null && isProviderTaxCode(taxClass)) {
    return { taxable, choice: TAX_CODE_CUSTOM, custom: taxClass, touched: false };
  }
  return { taxable, choice: TAX_CODE_DEFAULT, custom: '', touched: false };
}

/** The tax class the form means: null for the default, the typed code (normalised) for a custom one. */
export function taxClassOf(state: ProductTaxState): string | null {
  if (state.choice === TAX_CODE_DEFAULT) return null;
  if (state.choice === TAX_CODE_CUSTOM) return normalizeProviderTaxCode(state.custom);
  return state.choice;
}

/** A custom code that is empty or no Stripe / Avalara code. */
export function hasInvalidCustomCode(state: ProductTaxState): boolean {
  return state.choice === TAX_CODE_CUSTOM && !isProviderTaxCode(normalizeProviderTaxCode(state.custom));
}

/**
 * The tax fields to send with a save: only what differs from what the product
 * holds, so editing a name never rewrites the tax code and a create with the
 * defaults sends nothing. The code of a product that is not taxable is not
 * checked (its field is disabled), but a bad one is never sent.
 */
export function productTaxPayload(stored: StoredProductTax, state: ProductTaxState): ProductTaxPayload {
  const payload: ProductTaxPayload = {};
  if (state.taxable !== stored.taxable) payload.taxable = state.taxable;
  if (state.touched && !hasInvalidCustomCode(state)) {
    const taxClass = taxClassOf(state);
    if (taxClass !== stored.taxClass) payload.taxClass = taxClass;
  }
  return payload;
}

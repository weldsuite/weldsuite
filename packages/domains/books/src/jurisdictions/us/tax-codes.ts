/**
 * WeldBooks product tax codes and their mapping to each tax provider's codes
 * (docs/plans/weldbooks-us.md §6).
 *
 * Products store a WeldBooks code in `products.tax_class` and invoice and bill
 * lines in `tax_code`. The manual engine keys its taxability rules on the
 * WeldBooks code; Stripe Tax and Avalara AvaTax get the provider's own code.
 * A line may also carry a provider code directly (`txcd_20030000`,
 * `PC040100`) for a product the short list doesn't describe; the converters
 * pass such a code through to its own provider.
 *
 * The Stripe codes come from Stripe's published product tax code list. The
 * Avalara codes come from Avalara's list as reproduced by integration
 * vendors (PA0010000 and SW054002 in particular appear only there); Avalara
 * adds and retires codes, so confirm each in the AvaTax tax code search
 * (taxcode.avatax.avalara.com) before the provider engine goes live.
 */

import { SalesTaxEngineError, type TaxUse, type WeldTaxCode } from '../../sales-tax/types';

export type { WeldTaxCode, TaxUse };

export const WELD_TAX_CODES: readonly WeldTaxCode[] = [
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
];

/** The code a product gets when none is set: taxable as general tangible goods. */
export const DEFAULT_WELD_TAX_CODE: WeldTaxCode = 'general';

export function isWeldTaxCode(value: unknown): value is WeldTaxCode {
  return typeof value === 'string' && (WELD_TAX_CODES as readonly string[]).includes(value);
}

export interface WeldTaxCodeInfo {
  code: WeldTaxCode;
  label: string;
  description: string;
  kind: 'goods' | 'service' | 'digital' | 'charge' | 'exempt';
}

export const WELD_TAX_CODE_INFO: Readonly<Record<WeldTaxCode, WeldTaxCodeInfo>> = {
  general: {
    code: 'general',
    label: 'General goods',
    description: 'Tangible personal property: physical products that have no special treatment.',
    kind: 'goods',
  },
  saas: {
    code: 'saas',
    label: 'Software as a service',
    description: 'Hosted software the customer uses online. Taxable in some states (for example NY, TX, WA, PA, OH) and not in others.',
    kind: 'digital',
  },
  digital_goods: {
    code: 'digital_goods',
    label: 'Digital goods',
    description: 'Downloaded software, e-books, music, video and other electronically delivered products.',
    kind: 'digital',
  },
  services: {
    code: 'services',
    label: 'Services',
    description: 'General services. Most states do not tax them; some tax specific kinds.',
    kind: 'service',
  },
  professional_services: {
    code: 'professional_services',
    label: 'Professional services',
    description: 'Consulting, legal, accounting and similar services.',
    kind: 'service',
  },
  shipping: {
    code: 'shipping',
    label: 'Shipping',
    description: 'Shipping and delivery charges. Taxable in some states when the goods are, and exempt in others when separately stated.',
    kind: 'charge',
  },
  handling: {
    code: 'handling',
    label: 'Handling',
    description: 'Handling, packaging and service fees charged with a sale.',
    kind: 'charge',
  },
  food_grocery: {
    code: 'food_grocery',
    label: 'Groceries',
    description: 'Food and beverages for home consumption. Exempt or reduced in many states.',
    kind: 'goods',
  },
  prepared_food: {
    code: 'prepared_food',
    label: 'Prepared food',
    description: 'Restaurant meals, heated food and food sold with utensils.',
    kind: 'goods',
  },
  clothing: {
    code: 'clothing',
    label: 'Clothing',
    description: 'Apparel and footwear. Exempt or reduced in some states (for example NJ, PA, MN).',
    kind: 'goods',
  },
  prescription_drugs: {
    code: 'prescription_drugs',
    label: 'Prescription drugs',
    description: 'Drugs sold on a prescription. Exempt in nearly every state.',
    kind: 'goods',
  },
  non_taxable: {
    code: 'non_taxable',
    label: 'Non-taxable',
    description: 'Never taxed (for example donations, reimbursements, or items you have confirmed are exempt everywhere you sell).',
    kind: 'exempt',
  },
};

// ---------------------------------------------------------------------------
// Stripe Tax
// ---------------------------------------------------------------------------

interface UseSplit {
  business: string;
  personal: string;
}

type ProviderCode = string | UseSplit;

/**
 * Stripe Tax product tax codes (`txcd_...`). SaaS is the only product code
 * Stripe splits by use. Stripe also has a combined shipping and handling code
 * (`txcd_92010000`) for one charge covering both.
 * Digital goods use Stripe's general electronically supplied services code;
 * for a specific product (an e-book, a downloaded video) set the provider code
 * on the product (`txcd_10302000`, `txcd_10402100`, ...).
 */
const STRIPE_CODES: Record<WeldTaxCode, ProviderCode> = {
  general: 'txcd_99999999', // General - Tangible Goods
  saas: { business: 'txcd_10103001', personal: 'txcd_10103000' }, // SaaS, business / personal use
  digital_goods: 'txcd_10000000', // General - Electronically Supplied Services
  services: 'txcd_20030000', // General - Services
  professional_services: 'txcd_20060000', // Professional Services
  shipping: 'txcd_92010001', // Shipping
  handling: 'txcd_92010004', // Handling Charge
  food_grocery: 'txcd_40040000', // Food for Non-Immediate Consumption
  prepared_food: 'txcd_40060003', // Food for Immediate Consumption
  clothing: 'txcd_30011000', // Clothing & Footwear
  prescription_drugs: 'txcd_32020001', // Prescription Drugs
  non_taxable: 'txcd_00000000', // Nontaxable
};

const STRIPE_CODE_RE = /^txcd_\d{8}$/;

export function isStripeTaxCode(value: unknown): boolean {
  return typeof value === 'string' && STRIPE_CODE_RE.test(value);
}

function pick(code: ProviderCode, use: TaxUse): string {
  return typeof code === 'string' ? code : code[use];
}

/** A code no provider table knows: refuse rather than guess "taxable goods", which would tax groceries and prescriptions. */
function unmapped(provider: string, code: string): SalesTaxEngineError {
  return new SalesTaxEngineError(`No ${provider} tax code is mapped for "${code}"`, 'invalid_request');
}

/**
 * The Stripe product tax code for a WeldBooks code. A `txcd_` code passes
 * through; an empty code means general tangible goods; any other unknown code
 * throws a `SalesTaxEngineError` ('invalid_request').
 */
export function toStripeTaxCode(code: WeldTaxCode | string, use: TaxUse = 'business'): string {
  if (isWeldTaxCode(code)) return pick(STRIPE_CODES[code], use);
  if (isStripeTaxCode(code)) return code;
  if (code.trim() === '') return pick(STRIPE_CODES[DEFAULT_WELD_TAX_CODE], use);
  throw unmapped('Stripe', code);
}

// ---------------------------------------------------------------------------
// Avalara AvaTax
// ---------------------------------------------------------------------------

/**
 * Avalara tax codes. Clothing and SaaS split by use (B2B / B2C code
 * families); the others have one code. P0000000 is Avalara's own default for
 * tangible personal property and NT is the non-taxable code.
 */
const AVALARA_CODES: Record<WeldTaxCode, ProviderCode> = {
  general: 'P0000000', // Tangible personal property
  saas: { business: 'SW054002', personal: 'SW054000' }, // Cloud services, SaaS, service agreement (business use only / any use)
  digital_goods: 'D0000000', // Digital goods
  services: 'S0000000', // Services
  professional_services: 'SP140000', // Professional services
  shipping: 'FR020100', // Freight, shipping paid to a common carrier
  handling: 'OH010000', // Handling only charges (separately identified from shipping)
  food_grocery: 'PF050001', // Food and food ingredients (per SSUTA)
  prepared_food: 'PA0010000', // Prepared food / intended for immediate consumption
  clothing: { business: 'PC030100', personal: 'PC040100' }, // Clothing and related products, general (B2B / B2C)
  prescription_drugs: 'PH050102', // Drugs for human use with a prescription
  non_taxable: 'NT', // Non-taxable product
};

/** Avalara codes are upper-case letters and digits; WeldBooks codes are lower-case, so the two never clash. */
const AVALARA_CODE_RE = /^[A-Z]{1,2}[A-Z0-9]{0,10}$/;

export function isAvalaraTaxCode(value: unknown): boolean {
  return typeof value === 'string' && AVALARA_CODE_RE.test(value) && /\d|^NT$/.test(value);
}

/**
 * The Avalara tax code for a WeldBooks code. An Avalara code (`PC040100`)
 * passes through; an empty code means tangible personal property; any other
 * unknown code throws a `SalesTaxEngineError` ('invalid_request').
 */
export function toAvalaraTaxCode(code: WeldTaxCode | string, use: TaxUse = 'business'): string {
  if (isWeldTaxCode(code)) return pick(AVALARA_CODES[code], use);
  if (isAvalaraTaxCode(code)) return code;
  if (code.trim() === '') return pick(AVALARA_CODES[DEFAULT_WELD_TAX_CODE], use);
  throw unmapped('Avalara', code);
}

/**
 * The WeldBooks code a stored value means: a WeldBooks code as is, anything
 * else (empty, a provider code, a legacy `taxClass` word) falls back to the
 * default. Provider codes are kept by callers that want to pass them through.
 */
export function normalizeWeldTaxCode(value: string | null | undefined): WeldTaxCode {
  return isWeldTaxCode(value) ? value : DEFAULT_WELD_TAX_CODE;
}

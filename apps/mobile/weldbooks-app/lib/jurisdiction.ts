/**
 * Jurisdiction awareness: which modules an entity's country has, and the words
 * it uses for tax, tax ID, vendors and credit notes.
 *
 * The source of truth is `GET /api/accounting-entities/jurisdictions` (the
 * adapters in `packages/domains/books/src/jurisdictions`). The built-in table
 * below mirrors it so the app renders the right thing before that request
 * returns, offline, and when it fails — a Dutch entity never loses its VAT
 * screens and a US entity never shows them.
 *
 * Kept pure (no React, no network) so the rules can be unit-tested.
 */

import type {
  AccountingEntity,
  Jurisdiction,
  JurisdictionFeatures,
  JurisdictionTerminology,
} from '@/types/accounting';
import { INTL_LOCALES, type AppLanguage } from '@/lib/i18n/language';
import type { Translations } from '@/lib/i18n/locales/en';

/** Every jurisdiction-specific module off — an entity whose country is unknown. */
export const NO_FEATURES: JurisdictionFeatures = {
  vatReturn: false,
  icp: false,
  xafExport: false,
  smallBusinessScheme: false,
  gstReturn: false,
  salesTax: false,
  form1099: false,
};

/** Neutral wording for an entity whose country is unknown. */
export const DEFAULT_TERMINOLOGY: JurisdictionTerminology = {
  tax: 'vat',
  taxId: 'vat_number',
  registrationId: 'company_number',
  supplier: 'supplier',
  creditNote: 'credit_note',
};

/** The jurisdictions the API supports today, as the adapters declare them. */
export const BUILT_IN_JURISDICTIONS: readonly Jurisdiction[] = [
  {
    code: 'NL',
    name: 'Netherlands',
    defaultLocale: 'nl-NL',
    defaultCurrency: 'EUR',
    features: { ...NO_FEATURES, vatReturn: true, icp: true, xafExport: true, smallBusinessScheme: true },
    terminology: {
      tax: 'vat',
      taxId: 'vat_number',
      registrationId: 'kvk',
      supplier: 'supplier',
      creditNote: 'credit_note',
    },
  },
  {
    code: 'IN',
    name: 'India',
    defaultLocale: 'en-IN',
    defaultCurrency: 'INR',
    features: { ...NO_FEATURES, gstReturn: true },
    terminology: {
      tax: 'gst',
      taxId: 'gstin',
      registrationId: 'pan',
      supplier: 'supplier',
      creditNote: 'credit_note',
    },
  },
  {
    code: 'US',
    name: 'United States',
    defaultLocale: 'en-US',
    defaultCurrency: 'USD',
    features: { ...NO_FEATURES, salesTax: true, form1099: true },
    terminology: {
      tax: 'sales_tax',
      taxId: 'ein',
      registrationId: 'state_id',
      supplier: 'vendor',
      creditNote: 'credit_memo',
    },
  },
];

/** Default line tax rate (percent) a new VAT / GST line starts with. US lines carry a tax code instead. */
const DEFAULT_TAX_RATE: Record<string, string> = {
  NL: '21',
  IN: '18',
};

export function isUsJurisdiction(code: string | null | undefined): boolean {
  return code?.toUpperCase() === 'US';
}

/** The jurisdiction for a code: the API's list first, then the built-in table. */
export function findJurisdiction(
  code: string | null | undefined,
  loaded?: readonly Jurisdiction[] | null,
): Jurisdiction | null {
  if (!code) return null;
  const wanted = code.toUpperCase();
  return (
    loaded?.find((jurisdiction) => jurisdiction.code.toUpperCase() === wanted) ??
    BUILT_IN_JURISDICTIONS.find((jurisdiction) => jurisdiction.code === wanted) ??
    null
  );
}

export function defaultTaxRateFor(code: string | null | undefined): string {
  return (code && DEFAULT_TAX_RATE[code.toUpperCase()]) || '0';
}

/**
 * The jurisdiction the company setup starts on: the region of the device's
 * locale when it is one we support (a phone set to en-US starts on the United
 * States), otherwise the Netherlands, where WeldBooks started.
 */
export function defaultJurisdictionCode(deviceLocale?: string): string {
  let locale = deviceLocale;
  if (!locale) {
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      locale = undefined;
    }
  }
  const region = locale?.split(/[-_]/)[1]?.toUpperCase();
  return BUILT_IN_JURISDICTIONS.find((jurisdiction) => jurisdiction.code === region)?.code ?? 'NL';
}

/** Countries whose businesses bank on IBAN/BIC (SEPA) rather than account + routing numbers. */
const IBAN_COUNTRIES = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GI', 'GR',
  'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK', 'SM', 'VA',
]);

/** True when bank details for this jurisdiction are an IBAN (EU). */
export function usesIban(code: string | null | undefined): boolean {
  return !!code && IBAN_COUNTRIES.has(code.toUpperCase());
}

// ---------------------------------------------------------------------------
// Formatting locale
// ---------------------------------------------------------------------------

const EN_US = /^en[-_]US$/i;
const EN_REGION = /^en[-_][A-Za-z]{2}$/;

/**
 * The BCP 47 locale money and dates are formatted in.
 *
 * - A US entity always reads in US format ($1,234.56, MM/DD/YYYY), whatever
 *   language the app is in: it is what its invoices and the IRS use.
 * - An English-language user with another English-speaking entity (en-IN)
 *   gets that region's number style.
 * - Everyone else keeps the app language's own locale (en-GB, nl-NL), which is
 *   what the app did before entities carried a locale.
 */
export function resolveFormatLocale(
  language: AppLanguage,
  entityLocale: string | null | undefined,
): string {
  if (entityLocale) {
    if (EN_US.test(entityLocale)) return 'en-US';
    if (language === 'en' && EN_REGION.test(entityLocale)) return entityLocale.replace('_', '-');
  }
  return INTL_LOCALES[language];
}

/** US dates read month first and are typed as MM/DD/YYYY. */
export function usesUsDates(locale: string | null | undefined): boolean {
  return !!locale && EN_US.test(locale);
}

// ---------------------------------------------------------------------------
// Terminology
// ---------------------------------------------------------------------------

export interface TerminologyLabels {
  /** "VAT", "GST", "Sales tax" */
  tax: string;
  /** "VAT %", "Sales tax %" */
  taxPercent: string;
  /** "{rate}% VAT" — a template for `format()` */
  taxRateTemplate: string;
  /** "VAT number", "GSTIN", "EIN" */
  taxId: string;
  taxIdPlaceholder: string;
  /** "Supplier" / "Vendor" and its plural */
  supplier: string;
  suppliers: string;
  /** "Credit note" / "Credit memo" */
  creditNote: string;
}

/** Translate a jurisdiction's terminology codes with the app's catalog. */
export function terminologyLabels(
  catalog: Translations['terminology'],
  terminology: JurisdictionTerminology,
): TerminologyLabels {
  return {
    tax: catalog.tax[terminology.tax],
    taxPercent: catalog.taxPercent[terminology.tax],
    taxRateTemplate: catalog.taxRate[terminology.tax],
    taxId: catalog.taxId[terminology.taxId],
    taxIdPlaceholder: catalog.taxIdPlaceholder[terminology.taxId],
    supplier: catalog.supplier[terminology.supplier],
    suppliers: catalog.suppliers[terminology.supplier],
    creditNote: catalog.creditNote[terminology.creditNote],
  };
}

/**
 * The values catalog strings interpolate: `{supplier}`, `{suppliers}` and
 * `{creditNote}` in lower case for the middle of a sentence, `{Supplier}` and
 * `{CreditNote}` as labelled, plus `{tax}` and `{taxId}`.
 */
export function terminologyValues(labels: TerminologyLabels): Record<string, string> {
  return {
    tax: labels.tax,
    taxId: labels.taxId,
    supplier: labels.supplier.toLowerCase(),
    Supplier: labels.supplier,
    suppliers: labels.suppliers.toLowerCase(),
    creditNote: labels.creditNote.toLowerCase(),
    CreditNote: labels.creditNote,
  };
}

/**
 * The jurisdiction facts a screen needs for an entity, whether or not the
 * jurisdiction list has loaded.
 */
export interface JurisdictionContext {
  code: string | null;
  jurisdiction: Jurisdiction | null;
  features: JurisdictionFeatures;
  terminology: JurisdictionTerminology;
  isUs: boolean;
  usesIban: boolean;
  /** The entity's base currency; documents carry their own. */
  currency: string;
  /** Entity locale, from the entity row or the jurisdiction's default. */
  entityLocale: string | null;
}

/** Fallback when no entity is selected yet. */
export const FALLBACK_CURRENCY = 'EUR';

export function resolveJurisdictionContext(
  entity: Pick<AccountingEntity, 'jurisdictionCode' | 'baseCurrency' | 'locale'> | null | undefined,
  loaded?: readonly Jurisdiction[] | null,
): JurisdictionContext {
  const code = entity?.jurisdictionCode?.toUpperCase() ?? null;
  const jurisdiction = findJurisdiction(code, loaded);
  return {
    code,
    jurisdiction,
    features: jurisdiction?.features ?? NO_FEATURES,
    terminology: jurisdiction?.terminology ?? DEFAULT_TERMINOLOGY,
    isUs: isUsJurisdiction(code),
    usesIban: usesIban(code),
    currency: entity?.baseCurrency || jurisdiction?.defaultCurrency || FALLBACK_CURRENCY,
    entityLocale: entity?.locale || jurisdiction?.defaultLocale || null,
  };
}

/**
 * Jurisdiction metadata as returned by `GET /api/accounting-entities/jurisdictions`.
 * Mirrors `JurisdictionFeatures` / `JurisdictionTerminology` in
 * `@weldsuite/books-domain/jurisdictions/types` (the platform doesn't import
 * the domain package).
 */

export interface JurisdictionFeatures {
  /** Dutch BTW return (rubrieken), filed through Digipoort. */
  vatReturn: boolean;
  /** EU ICP listing of intra-community supplies. */
  icp: boolean;
  /** Dutch XAF audit file export. */
  xafExport: boolean;
  /** Small-business VAT exemption (NL KOR). */
  smallBusinessScheme: boolean;
  /** India GST return. */
  gstReturn: boolean;
  /** US sales tax. */
  salesTax: boolean;
  /** US 1099 information returns. */
  form1099: boolean;
}

export interface JurisdictionTerminology {
  tax: 'vat' | 'gst' | 'sales_tax';
  taxId: 'vat_number' | 'gstin' | 'ein';
  registrationId: 'kvk' | 'pan' | 'company_number' | 'state_id';
  supplier: 'supplier' | 'vendor';
  creditNote: 'credit_note' | 'credit_memo';
}

export interface JurisdictionSummary {
  code: string;
  name: string;
  defaultLocale: string;
  defaultCurrency: string;
  features: JurisdictionFeatures;
  terminology: JurisdictionTerminology;
}

/** Every jurisdiction-specific module off — used until the jurisdiction is known. */
export const NO_JURISDICTION_FEATURES: JurisdictionFeatures = {
  vatReturn: false,
  icp: false,
  xafExport: false,
  smallBusinessScheme: false,
  gstReturn: false,
  salesTax: false,
  form1099: false,
};

/** Neutral wording used until the jurisdiction is known. */
export const DEFAULT_TERMINOLOGY: JurisdictionTerminology = {
  tax: 'vat',
  taxId: 'vat_number',
  registrationId: 'company_number',
  supplier: 'supplier',
  creditNote: 'credit_note',
};

/** Countries whose businesses use IBAN/BIC (SEPA) rather than account + routing numbers. */
const IBAN_COUNTRIES = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GI', 'GR',
  'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK', 'SM', 'VA',
]);

/** True when bank details for this jurisdiction are an IBAN + BIC. */
export function usesIban(jurisdictionCode: string | null | undefined): boolean {
  return !!jurisdictionCode && IBAN_COUNTRIES.has(jurisdictionCode.toUpperCase());
}

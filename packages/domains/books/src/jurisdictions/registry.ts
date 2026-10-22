import type { InvoiceField, JurisdictionAdapter, JurisdictionFeatures, JurisdictionTerminology } from './types';
import { nlAdapter } from './nl';
import { inAdapter } from './in';
import { usAdapter } from './us';
import { brAdapter } from './br';

const adapters: Record<string, JurisdictionAdapter> = {
  NL: nlAdapter,
  IN: inAdapter,
  US: usAdapter,
  BR: brAdapter,
};

export function getAdapter(code: string): JurisdictionAdapter {
  const adapter = adapters[code.toUpperCase()];
  if (!adapter) {
    throw new Error(
      `No JurisdictionAdapter registered for '${code}'. Register it in services/jurisdictions/registry.ts.`,
    );
  }
  return adapter;
}

export function hasAdapter(code: string): boolean {
  return Boolean(adapters[code.toUpperCase()]);
}

export interface JurisdictionSummary {
  code: string;
  name: string;
  defaultLocale: string;
  defaultCurrency: string;
  features: JurisdictionFeatures;
  terminology: JurisdictionTerminology;
  /**
   * The entity fields an invoice of this jurisdiction cannot be finalized without (the supplier's
   * address always among them), so a client can ask for them up front.
   */
  invoiceRequiredFields: InvoiceField[];
}

/** The fields the entity must carry before an invoice can be finalized: the adapter's list plus the address. */
function invoiceRequiredFieldsOf(adapter: JurisdictionAdapter): InvoiceField[] {
  const fields = adapter.getInvoiceRequirements(adapter.defaultLocale).requiredFields;
  return fields.includes('address') ? [...fields] : [...fields, 'address'];
}

export function listJurisdictions(): JurisdictionSummary[] {
  return Object.values(adapters).map((a) => ({
    code: a.code,
    name: a.name,
    defaultLocale: a.defaultLocale,
    defaultCurrency: a.defaultCurrency,
    features: a.features,
    terminology: a.terminology,
    invoiceRequiredFields: invoiceRequiredFieldsOf(a),
  }));
}

/** Features of a jurisdiction; all off for a code with no adapter. */
export function getJurisdictionFeatures(code: string | null | undefined): JurisdictionFeatures {
  const adapter = code ? adapters[code.toUpperCase()] : undefined;
  return (
    adapter?.features ?? {
      vatReturn: false,
      icp: false,
      xafExport: false,
      smallBusinessScheme: false,
      gstReturn: false,
      salesTax: false,
      form1099: false,
      brTaxReturn: false,
      fiscalDocuments: false,
      spedEcd: false,
    }
  );
}

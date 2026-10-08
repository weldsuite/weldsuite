import type { JurisdictionAdapter, JurisdictionFeatures, JurisdictionTerminology } from './types';
import { nlAdapter } from './nl';
import { inAdapter } from './in';

const adapters: Record<string, JurisdictionAdapter> = {
  NL: nlAdapter,
  IN: inAdapter,
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
}

export function listJurisdictions(): JurisdictionSummary[] {
  return Object.values(adapters).map((a) => ({
    code: a.code,
    name: a.name,
    defaultLocale: a.defaultLocale,
    defaultCurrency: a.defaultCurrency,
    features: a.features,
    terminology: a.terminology,
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
    }
  );
}

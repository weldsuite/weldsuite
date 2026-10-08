import { useMemo } from 'react';
import { useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import {
  useCurrentAccountingEntityRow,
  type AccountingEntityCurrencyRow,
} from '@/hooks/use-current-entity-currency';
import { useI18n } from '@/lib/i18n/provider';
import {
  DEFAULT_TERMINOLOGY,
  NO_JURISDICTION_FEATURES,
  usesIban,
  type JurisdictionFeatures,
  type JurisdictionSummary,
  type JurisdictionTerminology,
} from './jurisdiction';

export interface CurrentJurisdiction {
  /** The selected entity's row from the entities list. */
  entity: AccountingEntityCurrencyRow | undefined;
  /** The selected entity's jurisdiction code (upper case), once known. */
  code: string | null;
  jurisdiction: JurisdictionSummary | null;
  /** All off until the jurisdiction is known. */
  features: JurisdictionFeatures;
  terminology: JurisdictionTerminology;
  /** True once the entity and the jurisdiction list have both loaded. */
  isResolved: boolean;
  /** True when the jurisdiction list could not be loaded. */
  isError: boolean;
  /** Bank details are IBAN/BIC (EU) rather than account + routing number. */
  usesIban: boolean;
}

/**
 * Features and terminology of the selected entity's jurisdiction, from
 * `GET /api/accounting-entities/jurisdictions`. Screens gate on `features`
 * instead of comparing jurisdiction codes.
 */
export function useCurrentJurisdiction(options: { enabled?: boolean } = {}): CurrentJurisdiction {
  const { entity, isError: entitiesError } = useCurrentAccountingEntityRow(options);
  const jurisdictionsQuery = useAccountingJurisdictions(options);
  const code = entity?.jurisdictionCode?.toUpperCase() ?? null;

  return useMemo(() => {
    const jurisdiction = code ? jurisdictionsQuery.data?.find((j) => j.code.toUpperCase() === code) ?? null : null;
    return {
      entity,
      code,
      jurisdiction,
      features: jurisdiction?.features ?? NO_JURISDICTION_FEATURES,
      terminology: jurisdiction?.terminology ?? DEFAULT_TERMINOLOGY,
      isResolved: !!jurisdiction,
      isError: jurisdictionsQuery.isError || entitiesError,
      usesIban: usesIban(code),
    };
  }, [entity, code, jurisdictionsQuery.data, jurisdictionsQuery.isError, entitiesError]);
}

/** Translated labels for the terminology codes of a jurisdiction. */
export function useTerminologyLabels(terminology: JurisdictionTerminology) {
  const { t } = useI18n();
  const tt = t.accounting.terminology;
  return useMemo(
    () => ({
      tax: tt.tax[terminology.tax],
      taxRate: tt.taxRate[terminology.tax],
      noTax: tt.noTax[terminology.tax],
      taxReturns: tt.taxReturns[terminology.tax],
      taxId: tt.taxId[terminology.taxId],
      registrationId: tt.registrationId[terminology.registrationId],
      supplier: tt.supplier[terminology.supplier],
      suppliers: tt.suppliers[terminology.supplier],
      supplierAddress: tt.supplierAddress[terminology.supplier],
      creditNote: tt.creditNote[terminology.creditNote],
      creditNotes: tt.creditNotes[terminology.creditNote],
    }),
    [tt, terminology],
  );
}

/** `useCurrentJurisdiction()` plus the translated terminology labels. */
export function useJurisdictionLabels() {
  const current = useCurrentJurisdiction();
  const labels = useTerminologyLabels(current.terminology);
  return { ...current, labels };
}

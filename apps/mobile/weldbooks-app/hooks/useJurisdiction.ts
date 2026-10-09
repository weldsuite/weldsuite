/**
 * The active entity's jurisdiction: which modules it has, the words it uses
 * and the currency and locale it formats in.
 *
 * The jurisdiction list (`GET /accounting-entities/jurisdictions`) is loaded
 * once and kept for the session — it only changes with an app release. Until it
 * arrives, and if it never does, the built-in table in `lib/jurisdiction.ts`
 * answers, so screens never wait on it.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import api from '@/services/api';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useI18n } from '@/lib/i18n';
import {
  resolveFormatLocale,
  resolveJurisdictionContext,
  terminologyLabels,
  terminologyValues,
  type JurisdictionContext,
  type TerminologyLabels,
} from '@/lib/jurisdiction';
import { booksKeys } from '@/lib/sync-map';
import type { AccountingEntity, Jurisdiction } from '@/types/accounting';

/** The supported jurisdictions, fetched once. */
export function useJurisdictions() {
  return useQuery<Jurisdiction[]>({
    queryKey: booksKeys.jurisdictions(),
    queryFn: () => api.getJurisdictions(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

export interface CurrentJurisdiction extends JurisdictionContext {
  entity: AccountingEntity | null;
  /** Terminology codes translated for the app language. */
  labels: TerminologyLabels;
  /** The values catalog strings interpolate (`{supplier}`, `{CreditNote}`, `{tax}`, ...). */
  terms: Record<string, string>;
  /** The locale money and dates are formatted in. */
  formatLocale: string;
  /** True once the API's jurisdiction list has loaded (the built-in table answers before). */
  isResolved: boolean;
}

export function useJurisdiction(): CurrentJurisdiction {
  const { activeEntity } = useAccountingEntity();
  const { t, language } = useI18n();
  const { data } = useJurisdictions();

  return useMemo(() => {
    const context = resolveJurisdictionContext(activeEntity, data);
    const labels = terminologyLabels(t.terminology, context.terminology);
    return {
      ...context,
      entity: activeEntity,
      labels,
      terms: terminologyValues(labels),
      formatLocale: resolveFormatLocale(language, context.entityLocale),
      isResolved: Boolean(data),
    };
  }, [activeEntity, data, t, language]);
}

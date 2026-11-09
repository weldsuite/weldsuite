import { useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Label of a legal form code (`bv`, `llc`, ...): the US setup labels first,
 * then the WeldBooks ones, else the code in capitals.
 */
export function useLegalFormLabel(): (code: string) => string {
  const { t } = useI18n();
  const usLabels = t.weldbooksUs.setup.entityTypes as Record<string, string>;
  const labels = t.accounting.entityTypes as Record<string, string>;
  return useCallback((code: string) => usLabels[code] ?? labels[code] ?? code.toUpperCase(), [usLabels, labels]);
}

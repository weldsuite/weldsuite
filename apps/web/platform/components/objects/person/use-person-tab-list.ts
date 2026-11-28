import { useMemo } from 'react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { isFeatureAvailable } from '@/lib/edition';
import { getLocale, getTranslations } from '@/lib/i18n';
import { personTabs, type PersonTab } from './person-tabs';

/**
 * The tabs of the person panel for this member and edition: the Finance tab (WeldBooks contact page) joins them
 * where the edition has it and the member can read invoices; its label is the UI language's.
 */
export function usePersonTabList(): PersonTab[] {
  const permissions = usePermissionsMaybe();
  const showFinance = isFeatureAvailable('books-contact-page') && (permissions?.can('invoices:read') ?? false);
  const locale = getLocale();
  return useMemo(
    () =>
      personTabs(showFinance).map((tab) =>
        tab.id === 'finance' ? { ...tab, label: getTranslations('weldbooksContactPage').finance.tab } : tab,
      ),
    // The locale is read inside getTranslations: a change of language must rebuild the labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showFinance, locale],
  );
}

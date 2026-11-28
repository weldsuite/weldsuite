import { useMemo } from 'react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { isFeatureAvailable } from '@/lib/edition';
import { getLocale, getTranslations } from '@/lib/i18n';
import { canShowBuyers, canShowFinance, companyTabs, type CompanyTab } from './company-tabs';

/**
 * The tabs of the company panel for this member and edition: the Buyers tab
 * (WeldCommerce, phase 6) joins them where WeldCommerce is offered and the
 * member can read companies, and the Finance tab (WeldBooks contact page) where the edition has it and the
 * member can read invoices; their labels are the UI language's.
 */
export function useCompanyTabList(): CompanyTab[] {
  const permissions = usePermissionsMaybe();
  const showBuyers = canShowBuyers(isFeatureAvailable('commerce'), permissions?.can('companies:read') ?? false);
  const showFinance = canShowFinance(isFeatureAvailable('books-contact-page'), permissions?.can('invoices:read') ?? false);
  const locale = getLocale();
  return useMemo(
    () =>
      companyTabs(showBuyers, showFinance).map((tab) => {
        if (tab.id === 'buyers') return { ...tab, label: getTranslations('commerce').buyers.tab };
        if (tab.id === 'finance') return { ...tab, label: getTranslations('weldbooksContactPage').finance.tab };
        return tab;
      }),
    // The locale is read inside getTranslations: a change of language must rebuild the labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showBuyers, showFinance, locale],
  );
}

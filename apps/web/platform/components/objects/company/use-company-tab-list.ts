import { useMemo } from 'react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { isFeatureAvailable } from '@/lib/edition';
import { getLocale, getTranslations } from '@/lib/i18n';
import { canShowBuyers, companyTabs, type CompanyTab } from './company-tabs';

/**
 * The tabs of the company panel for this member and edition: the Buyers tab
 * (WeldCommerce, phase 6) joins them where WeldCommerce is offered and the
 * member can read companies; its label is the UI language's.
 */
export function useCompanyTabList(): CompanyTab[] {
  const permissions = usePermissionsMaybe();
  const showBuyers = canShowBuyers(isFeatureAvailable('commerce'), permissions?.can('companies:read') ?? false);
  const locale = getLocale();
  return useMemo(
    () =>
      companyTabs(showBuyers).map((tab) =>
        tab.id === 'buyers' ? { ...tab, label: getTranslations('commerce').buyers.tab } : tab,
      ),
    // The locale is read inside getTranslations: a change of language must rebuild the labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showBuyers, locale],
  );
}

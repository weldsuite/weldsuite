import { useCallback } from 'react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const TAX_HREF = '/weldbooks/vat';
const SUPPLIERS_HREF = '/weldbooks/suppliers';
const CREDIT_NOTES_HREF = '/weldbooks/credit-notes';

/**
 * Adjusts the static WeldBooks menu (MODULE_CONFIGS.weldbooks) to the selected
 * entity's jurisdiction:
 * - the tax item is shown only when the jurisdiction has a VAT return
 *   (`features.vatReturn`) and is labelled from the terminology
 *   (VAT / GST / Sales tax);
 * - "Suppliers" / "Credit notes" become "Vendors" / "Credit memos" where the
 *   jurisdiction says so.
 *
 * Until the jurisdiction is known the tax item stays hidden, so a US entity
 * never flashes a Dutch VAT screen; if the jurisdictions can't be loaded the
 * static menu is used as is.
 */
export function useWeldbooksSidebarItems(enabled: boolean) {
  const { t } = useI18n();
  const { features, terminology, isResolved, isError } = useCurrentJurisdiction({ enabled });
  const nav = t.navigation.moduleSidebar.weldbooks;

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled || isError) return groups;
      return groups.map((group) => ({
        ...group,
        items: group.items
          .filter((item) => item.href !== TAX_HREF || (isResolved && features.vatReturn))
          .map((item) => {
            if (item.href === TAX_HREF) return { ...item, title: nav.taxNav[terminology.tax] };
            if (item.href === SUPPLIERS_HREF && terminology.supplier === 'vendor') {
              return { ...item, title: nav.vendors };
            }
            if (item.href === CREDIT_NOTES_HREF && terminology.creditNote === 'credit_memo') {
              return { ...item, title: nav.creditMemos };
            }
            return item;
          }),
      }));
    },
    [enabled, isError, isResolved, features.vatReturn, terminology, nav],
  );

  return { adjust };
}

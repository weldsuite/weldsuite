import { useCallback } from 'react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useI18n } from '@/lib/i18n/provider';
import { isWeldbooksHrefVisible, WELDBOOKS_TAX_HREF } from '@/lib/weldbooks/jurisdiction-menu';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const TAX_HREF = WELDBOOKS_TAX_HREF;
const SUPPLIERS_HREF = '/weldbooks/suppliers';
const CREDIT_NOTES_HREF = '/weldbooks/credit-notes';

/**
 * Adjusts the static WeldBooks menu (MODULE_CONFIGS.weldbooks) to the selected
 * entity's jurisdiction:
 * - the tax-return item is shown only when the jurisdiction has a VAT return
 *   (`features.vatReturn`), a GST return (`features.gstReturn`) or a Brazilian apuração
 *   (`features.brTaxReturn`) and is labelled from the terminology (VAT / GST / Sales tax / Taxes);
 * - the received NF-e inbox needs `features.fiscalDocuments` (Brazil);
 * - the US screens (Sales Tax Center, nexus, certificates, tax calendar,
 *   payment runs, deposits, statement reconciliation, tax worksheet) need
 *   `features.salesTax`, and 1099s need `features.form1099`;
 * - "Suppliers" / "Credit notes" become "Vendors" / "Credit memos" where the
 *   jurisdiction says so;
 * - groups left without items are dropped.
 *
 * Until the jurisdiction is known the gated items stay hidden, so a US entity
 * never flashes a Dutch VAT screen and a Dutch one never flashes US screens.
 * If the jurisdictions can't be loaded the gated items stay hidden.
 */
export function useWeldbooksSidebarItems(enabled: boolean) {
  const { t } = useI18n();
  const { features, terminology, isResolved, isError } = useCurrentJurisdiction({ enabled });
  const nav = t.navigation.moduleSidebar.weldbooks;

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled) return groups;
      const known = isResolved && !isError;
      const visible = (href: string): boolean => isWeldbooksHrefVisible(href, { known, features });
      return groups
        .map((group) => ({
          ...group,
          items: group.items
            .filter((item) => visible(item.href))
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
        }))
        .filter((group) => group.items.length > 0);
    },
    [
      enabled,
      isError,
      isResolved,
      features,
      terminology,
      nav,
    ],
  );

  return { adjust };
}

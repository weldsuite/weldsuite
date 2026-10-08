import { useCallback } from 'react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const TAX_HREF = '/weldbooks/vat';
const SUPPLIERS_HREF = '/weldbooks/suppliers';
const CREDIT_NOTES_HREF = '/weldbooks/credit-notes';
const FORM_1099_HREF = '/weldbooks/form-1099';

/** Screens that only exist for jurisdictions with US sales tax. */
const SALES_TAX_HREFS = new Set([
  '/weldbooks/sales-tax',
  '/weldbooks/sales-tax/certificates',
  '/weldbooks/sales-tax/nexus',
  '/weldbooks/tax-calendar',
  '/weldbooks/payment-runs',
  '/weldbooks/deposits',
  '/weldbooks/banking/statements',
  '/weldbooks/reports/tax-worksheet',
]);

/**
 * Adjusts the static WeldBooks menu (MODULE_CONFIGS.weldbooks) to the selected
 * entity's jurisdiction:
 * - the VAT item is shown only when the jurisdiction has a VAT return
 *   (`features.vatReturn`) and is labelled from the terminology
 *   (VAT / GST / Sales tax);
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
      const visible = (href: string): boolean => {
        if (href === TAX_HREF) return known && features.vatReturn;
        if (href === FORM_1099_HREF) return known && features.form1099;
        if (SALES_TAX_HREFS.has(href)) return known && features.salesTax;
        return true;
      };
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
    [enabled, isError, isResolved, features.vatReturn, features.form1099, features.salesTax, terminology, nav],
  );

  return { adjust };
}

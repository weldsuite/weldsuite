import { useCallback } from 'react';
import { formatCount } from '@weldsuite/ui/components/count-badge';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useTodoSummary } from '@/hooks/queries/use-weldbooks-todo-queries';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname, useSearchParams } from '@/lib/router';
import { isWeldbooksHrefVisible, WELDBOOKS_TAX_HREF } from '@/lib/weldbooks/jurisdiction-menu';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const TAX_HREF = WELDBOOKS_TAX_HREF;
const CONTACTS_HREF = '/weldbooks/contacts';
const CUSTOMERS_HREF = '/weldbooks/customers';
const SUPPLIERS_HREF = '/weldbooks/suppliers';
const TO_PROCESS_HREF = '/weldbooks/to-process';
const INBOX_HREF = '/weldbooks/documents';
const TRANSACTIONS_HREF = '/weldbooks/banking/transactions';

/** The contact form is one route for both roles: `?role=supplier` makes it the new-supplier form. */
export function isSupplierContactForm(pathname: string, role: string | null): boolean {
  return pathname.startsWith(`${CUSTOMERS_HREF}/add`) && role === 'supplier';
}

/** The pages that are the one Contacts list: the list itself and the old customer and supplier routes. */
function isContactsPath(pathname: string): boolean {
  return [CONTACTS_HREF, CUSTOMERS_HREF, SUPPLIERS_HREF].some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/**
 * Adjusts the static WeldBooks menu (MODULE_CONFIGS.weldbooks) to the selected
 * entity's jurisdiction and to the edition:
 * - the tax-return item is shown only when the jurisdiction has a VAT return
 *   (`features.vatReturn`), a GST return (`features.gstReturn`) or a Brazilian apuração
 *   (`features.brTaxReturn`) and is labelled from the terminology (VAT / GST / Sales tax / Taxes);
 * - the received NF-e inbox needs `features.fiscalDocuments` (Brazil);
 * - the US screens (Sales Tax Center, nexus, certificates, tax calendar,
 *   payment runs, deposits, statement reconciliation, tax worksheet) need
 *   `features.salesTax`, and 1099s need `features.form1099`;
 * - Contacts stays active on the old customer and supplier routes (the words
 *   "Vendors" and "Credit memos" follow the terminology in the Contacts filter
 *   and the Invoices filter, where the pages use them);
 * - To process, Inbox and Transactions carry the counts of the to-process
 *   summary (edition feature `books-todo`), refreshed only while someone is at
 *   the screen;
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
  const menuCopy = t.weldbooksConnected.menu;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // A new supplier is filled in on the customers route: it is still the Contacts list's family.
  const supplierForm = isSupplierContactForm(pathname, searchParams.get('role'));
  const contactsActive = supplierForm || isContactsPath(pathname);
  // Only polled where the edition serves it, and only while the module's menu is shown.
  const { data: todo } = useTodoSummary({ enabled });
  const total = todo?.total ?? 0;
  const documents = todo?.kinds.documents?.count ?? 0;
  const bankLines = todo?.kinds.bank_lines?.count ?? 0;

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled) return groups;
      const known = isResolved && !isError;
      const visible = (href: string): boolean => isWeldbooksHrefVisible(href, { known, features });
      const counted = (count: number, label: string) =>
        count > 0 ? { badge: formatCount(count), badgeLabel: label.replace('{count}', String(count)) } : {};
      return groups
        .map((group) => ({
          ...group,
          items: group.items
            .filter((item) => visible(item.href))
            .map((item) => {
              if (item.href === TAX_HREF) return { ...item, title: nav.taxNav[terminology.tax] };
              if (item.href === CONTACTS_HREF) return { ...item, isActive: contactsActive };
              if (item.href === TO_PROCESS_HREF) return { ...item, ...counted(total, menuCopy.toProcessBadge) };
              if (item.href === INBOX_HREF) return { ...item, ...counted(documents, menuCopy.inboxBadge) };
              if (item.href === TRANSACTIONS_HREF) return { ...item, ...counted(bankLines, menuCopy.bankBadge) };
              return item;
            }),
        }))
        .filter((group) => group.items.length > 0);
    },
    [enabled, isError, isResolved, features, terminology, nav, menuCopy, contactsActive, total, documents, bankLines],
  );

  return { adjust };
}

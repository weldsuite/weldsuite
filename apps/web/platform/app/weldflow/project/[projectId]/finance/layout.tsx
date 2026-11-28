import type { ReactNode } from 'react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { isTimeBillingAvailable } from '@/hooks/queries/use-weldbooks-time-billing-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/**
 * The Finance tab: the budget overview, the cost register and the forecast, and (edition feature `books-time-billing`,
 * for a member who can read invoices) what is invoiced, in draft and still to invoice.
 */
export default function FinanceLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const copy = t.projects.subNav.finance;
  const permissions = usePermissionsMaybe();
  const showInvoicing = isTimeBillingAvailable() && (permissions?.can('invoices:read') ?? false);
  const items: SubNavItem[] = [
    { id: 'overview', label: copy.overview, path: '' },
    { id: 'costs', label: copy.costs, path: '/costs' },
    { id: 'forecast', label: copy.forecast, path: '/forecast' },
    ...(showInvoicing ? [{ id: 'invoicing', label: t.weldbooksContactPage.flow.finance.tab, path: '/invoicing' }] : []),
  ];
  return (
    <ProjectSubNavLayout section="finance" label={copy.label} items={items} flushIds={['costs']}>
      {children}
    </ProjectSubNavLayout>
  );
}

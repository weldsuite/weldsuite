import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/** The Finance tab: the budget overview, the cost register and the forecast. */
export default function FinanceLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const copy = t.projects.subNav.finance;
  const items: SubNavItem[] = [
    { id: 'overview', label: copy.overview, path: '' },
    { id: 'costs', label: copy.costs, path: '/costs' },
    { id: 'forecast', label: copy.forecast, path: '/forecast' },
  ];
  return (
    <ProjectSubNavLayout section="finance" label={copy.label} items={items}>
      {children}
    </ProjectSubNavLayout>
  );
}

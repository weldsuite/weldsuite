/**
 * Settings → Workspace → Entities: the workspace's legal entities in one
 * place. The Accounting tab holds the WeldBooks entities, the Payroll
 * employers tab the WeldHR employers (which can link to a WeldBooks entity).
 * A tab shows only when its app is installed and the member may manage it.
 */

import { useMemo } from 'react';
import { Banknote, Building2, Lock } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';
import { useI18n } from '@/lib/i18n/provider';
import { emptyIcon } from '@/app/weldhr/components/page-kit';
import { PayrollEmployersSection } from '@/app/weldhr/payroll/components/employers-section';
import { AccountingEntitiesTab } from './components/accounting-entities-tab';

const TABS = ['accounting', 'employers'] as const;
type EntitiesTab = (typeof TABS)[number];

function isEntitiesTab(value: string | undefined): value is EntitiesTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

export default function EntitiesSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.entities;
  const { can, isOwner, isLoading: permissionsLoading } = usePermissions();
  const { data: apps, isLoading: appsLoading } = useInstalledApps();
  const payrollFlag = useHrPayrollFlag();
  // Not strict, so the page also renders when mounted under another route.
  const search: { tab?: string } = useSearch({ strict: false });
  const navigate = useNavigate();

  const installed = useMemo(
    () => new Set((apps ?? []).filter((app) => app.status === 'active').map((app) => app.appCode)),
    [apps],
  );

  const showAccounting = installed.has('weldbooks') && (isOwner || can('entities:read'));
  const showEmployers = installed.has('weldhr') && payrollFlag.enabled && (isOwner || can('payroll:manage'));

  const tabs: PageTab[] = [
    ...(showAccounting ? [{ id: 'accounting', label: ts.tabs.accounting, icon: Building2 }] : []),
    ...(showEmployers ? [{ id: 'employers', label: ts.tabs.employers, icon: Banknote }] : []),
  ];

  const requested = isEntitiesTab(search.tab) ? search.tab : undefined;
  const activeTab = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id;

  // Always name the tab: which tab comes first depends on installed apps and permissions.
  function setTab(tab: string) {
    navigate({ to: '/settings/entities', search: { tab } });
  }

  const loading = permissionsLoading || appsLoading || payrollFlag.isLoading;

  let content: React.ReactNode;
  if (loading) {
    content = <PageLoader fullScreen={false} />;
  } else if (tabs.length === 0) {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        {emptyIcon(Lock)}
        <p className="text-sm font-medium">{ts.noAccess}</p>
      </div>
    );
  } else {
    content = (
      <>
        {tabs.length > 1 && <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setTab} overflow="dropdown" />}
        <div className={tabs.length > 1 ? 'mt-6 space-y-6' : 'space-y-6'}>
          {activeTab === 'accounting' && <AccountingEntitiesTab />}
          {activeTab === 'employers' && <PayrollEmployersSection />}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>
      {content}
    </div>
  );
}

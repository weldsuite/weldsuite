import { Banknote, Building2, Lock, MapPin, Plane, UserCog } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { usePermissions } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { emptyIcon } from '@/app/weldhr/components/page-kit';
import { DepartmentsTab } from '@/app/weldhr/settings/components/departments-tab';
import { LeaveTypesTab } from '@/app/weldhr/settings/components/leave-types-tab';
import { SelfServiceTab } from '@/app/weldhr/settings/components/self-service-tab';
import { WorkLocationsTab } from '@/app/weldhr/settings/components/work-locations-tab';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';
import { PaySchedulesTab } from './pay-schedules-tab';

const HR_TABS = ['departments', 'leave-types', 'work-locations', 'self-service'] as const;
const TABS = [...HR_TABS, 'pay-schedules'] as const;
type SettingsTab = (typeof TABS)[number];

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

export default function WeldHrSettingsPage() {
  const ts = getTranslations('settings');
  const hr = getTranslations('weldhr');
  const { can } = usePermissions();
  const payrollFlag = useHrPayrollFlag();
  const search = useSearch({ from: '/settings/apps/weldhr' });
  const navigate = useNavigate();
  const canManage = can('employees:manage');
  // Pay schedules need the weldhr-payroll flag as well as payroll:manage.
  const canPayroll = payrollFlag.enabled && can('payroll:manage');

  const allowed: SettingsTab[] = [...(canManage ? HR_TABS : []), ...(canPayroll ? (['pay-schedules'] as const) : [])];
  const requested = isSettingsTab(search.tab) ? search.tab : undefined;
  const activeTab: SettingsTab | undefined = requested && allowed.includes(requested) ? requested : allowed[0];
  const defaultTab = allowed[0];

  function setTab(tab: string) {
    void navigate({
      to: '/settings/apps/weldhr',
      search: tab === defaultTab ? {} : { tab },
    });
  }

  const tabs: PageTab[] = [
    ...(canManage
      ? [
          { id: 'departments', label: hr.settings.tabs.departments, icon: Building2 },
          { id: 'leave-types', label: hr.settings.tabs.leaveTypes, icon: Plane },
          { id: 'work-locations', label: hr.settings.tabs.workLocations, icon: MapPin },
          { id: 'self-service', label: hr.settings.tabs.selfService, icon: UserCog },
        ]
      : []),
    ...(canPayroll ? [{ id: 'pay-schedules', label: hr.settings.tabs.paySchedules, icon: Banknote }] : []),
  ];

  // A deep link to the pay schedules waits for the flag rather than falling back to another tab.
  const waitingForPayroll = requested === 'pay-schedules' && payrollFlag.isLoading;

  return (
    // `min-w-0`: never wider than the settings column, so the list's toolbar and row menus stay reachable.
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldhr.title}</h1>
        <p className="text-muted-foreground">{ts.weldhr.description}</p>
      </div>
      {waitingForPayroll && <PageLoader fullScreen={false} />}
      {!waitingForPayroll && activeTab && (
        <>
          <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setTab} overflow="dropdown" />
          <div className="@container mt-6">
            {activeTab === 'departments' && <DepartmentsTab />}
            {activeTab === 'leave-types' && <LeaveTypesTab />}
            {activeTab === 'work-locations' && <WorkLocationsTab />}
            {activeTab === 'self-service' && <SelfServiceTab />}
            {activeTab === 'pay-schedules' && <PaySchedulesTab />}
          </div>
        </>
      )}
      {!waitingForPayroll && !activeTab && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          {emptyIcon(Lock)}
          <p className="text-sm font-medium">{hr.common.noPermission}</p>
        </div>
      )}
    </div>
  );
}

import { Building2, Lock, MapPin, Plane, UserCog } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { usePermissions } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { emptyIcon } from '@/app/weldhr/components/page-kit';
import { DepartmentsTab } from '@/app/weldhr/settings/components/departments-tab';
import { LeaveTypesTab } from '@/app/weldhr/settings/components/leave-types-tab';
import { SelfServiceTab } from '@/app/weldhr/settings/components/self-service-tab';
import { WorkLocationsTab } from '@/app/weldhr/settings/components/work-locations-tab';

const TABS = ['departments', 'leave-types', 'work-locations', 'self-service'] as const;
type SettingsTab = (typeof TABS)[number];

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

export default function WeldHrSettingsPage() {
  const ts = getTranslations('settings');
  const hr = getTranslations('weldhr');
  const { can } = usePermissions();
  const search = useSearch({ from: '/settings/apps/weldhr' });
  const navigate = useNavigate();
  const canManage = can('employees:manage');

  const activeTab: SettingsTab = isSettingsTab(search.tab) ? search.tab : 'departments';

  function setTab(tab: string) {
    navigate({
      to: '/settings/apps/weldhr',
      search: tab === 'departments' ? {} : { tab },
    });
  }

  const tabs: PageTab[] = [
    { id: 'departments', label: hr.settings.tabs.departments, icon: Building2 },
    { id: 'leave-types', label: hr.settings.tabs.leaveTypes, icon: Plane },
    { id: 'work-locations', label: hr.settings.tabs.workLocations, icon: MapPin },
    { id: 'self-service', label: hr.settings.tabs.selfService, icon: UserCog },
  ];

  return (
    // `min-w-0`: never wider than the settings column, so the list's toolbar and row menus stay reachable.
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldhr.title}</h1>
        <p className="text-muted-foreground">{ts.weldhr.description}</p>
      </div>
      {canManage ? (
        <>
          <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setTab} overflow="dropdown" />
          <div className="@container mt-6">
            {activeTab === 'departments' && <DepartmentsTab />}
            {activeTab === 'leave-types' && <LeaveTypesTab />}
            {activeTab === 'work-locations' && <WorkLocationsTab />}
            {activeTab === 'self-service' && <SelfServiceTab />}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          {emptyIcon(Lock)}
          <p className="text-sm font-medium">{hr.common.noPermission}</p>
        </div>
      )}
    </div>
  );
}

import { Building2, Lock, Plane } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { usePermissions } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { emptyIcon } from '@/app/weldhr/components/page-kit';
import { DepartmentsTab } from '@/app/weldhr/settings/components/departments-tab';
import { LeaveTypesTab } from '@/app/weldhr/settings/components/leave-types-tab';

const TABS = ['departments', 'leave-types'] as const;
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
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldhr.title}</h1>
        <p className="text-muted-foreground">{ts.weldhr.description}</p>
      </div>
      {canManage ? (
        <>
          <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setTab} overflow="dropdown" />
          <div className="mt-6">
            {activeTab === 'departments' && <DepartmentsTab />}
            {activeTab === 'leave-types' && <LeaveTypesTab />}
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

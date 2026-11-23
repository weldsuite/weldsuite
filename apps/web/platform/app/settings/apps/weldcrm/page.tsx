import { ListTodo, Tag, UserPlus } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/router';
import CustomerStatusesPage from '@/app/settings/weldcrm/customer-statuses/page';
import { TaskSchedulingSwitch } from '@/app/settings/apps/task-scheduling-switch';
import { AutoAddSettings } from '@/app/settings/apps/weldcrm/auto-add-settings';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';

const TAB_VALUES = ['statuses', 'auto-add', 'tasks'] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function WeldCrmSettingsPage() {
  const { t } = useI18n();
  const ts = getTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Auto-add is built only in the Rust backend: Global has no tab for it.
  const autoAdd = isFeatureAvailable('crm-auto-add');
  const tabParam = searchParams.get('tab');
  const offered = (tab: TabValue) => tab !== 'auto-add' || autoAdd;
  const activeTab: TabValue =
    TAB_VALUES.includes(tabParam as TabValue) && offered(tabParam as TabValue)
      ? (tabParam as TabValue)
      : 'statuses';

  const tabs: PageTab[] = [
    { id: 'statuses', label: t.crm.settings.customerStatuses.title, icon: Tag },
    ...(autoAdd ? [{ id: 'auto-add', label: t.crm.settings.autoAdd.tab, icon: UserPlus }] : []),
    { id: 'tasks', label: ts.taskScheduling.tab, icon: ListTodo },
  ];

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'statuses') {
      params.delete('tab');
    } else {
      params.set('tab', value);
    }
    const qs = params.toString();
    const query = qs ? `?${qs}` : '';
    router.push(`/settings/apps/weldcrm${query}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldcrm.title}</h1>
        <p className="text-muted-foreground">{ts.weldcrm.description}</p>
      </div>
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="mt-6">
        {activeTab === 'statuses' && <CustomerStatusesPage />}
        {activeTab === 'auto-add' && <AutoAddSettings />}
        {activeTab === 'tasks' && <TaskSchedulingSwitch preference="autoScheduleCrmTasks" />}
      </div>
    </div>
  );
}

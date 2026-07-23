import { Tag } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/router';
import CustomerStatusesPage from '@/app/settings/weldcrm/customer-statuses/page';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';

const TAB_VALUES = ['statuses'] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function WeldCrmSettingsPage() {
  const { t } = useI18n();
  const ts = getTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabValue = TAB_VALUES.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'statuses';

  const tabs: PageTab[] = [
    { id: 'statuses', label: t.crm.settings.customerStatuses.title, icon: Tag },
  ];

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'statuses') {
      params.delete('tab');
    } else {
      params.set('tab', value);
    }
    const qs = params.toString();
    router.push(`/settings/apps/weldcrm${qs ? `?${qs}` : ''}`);
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
      </div>
    </div>
  );
}

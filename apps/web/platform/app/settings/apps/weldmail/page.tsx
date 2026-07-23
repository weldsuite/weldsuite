import { Users } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/router';
import EmailAccountsSettingsPage from './accounts/page';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { getTranslations } from '@/lib/i18n';

const TAB_VALUES = ['accounts'] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function WeldMailSettingsPage() {
  const ts = getTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabs: PageTab[] = [
    { id: 'accounts', label: ts.weldmail.tabs.accounts, icon: Users },
  ];
  const tabParam = searchParams.get('tab');
  const activeTab: TabValue = TAB_VALUES.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'accounts';

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'accounts') {
      params.delete('tab');
    } else {
      params.set('tab', value);
    }
    const qs = params.toString();
    router.push(`/settings/apps/weldmail${qs ? `?${qs}` : ''}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldmail.title}</h1>
        <p className="text-muted-foreground">
          {ts.weldmail.description}
        </p>
      </div>
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="mt-6">
        {activeTab === 'accounts' && <EmailAccountsSettingsPage />}
      </div>
    </div>
  );
}

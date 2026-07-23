import { Mail, Ticket, Globe } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/router';
import { HelpdeskSettingsSection } from '@/components/settings';
import { TicketsSettingsClient } from '@/app/welddesk/settings/tickets/tickets-settings-client';
import HelpcenterPage from '@/app/welddesk/helpcenter/page';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { getTranslations } from '@/lib/i18n';

const TAB_VALUES = ['email', 'tickets', 'helpcenter'] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function HelpdeskSettingsPage() {
  const ts = getTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabs: PageTab[] = [
    { id: 'email', label: ts.welddesk.tabs.email, icon: Mail },
    { id: 'tickets', label: ts.welddesk.tabs.tickets, icon: Ticket },
    { id: 'helpcenter', label: ts.welddesk.tabs.helpcenter, icon: Globe },
  ];
  const tabParam = searchParams.get('tab');
  const activeTab: TabValue = TAB_VALUES.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'email';

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'email') {
      params.delete('tab');
    } else {
      params.set('tab', value);
    }
    const qs = params.toString();
    router.push(`/settings/apps/welddesk${qs ? `?${qs}` : ''}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.welddesk.title}</h1>
        <p className="text-muted-foreground">{ts.welddesk.description}</p>
      </div>
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="mt-6">
        {activeTab === 'email' && <HelpdeskSettingsSection />}
        {activeTab === 'tickets' && <TicketsSettingsClient />}
        {activeTab === 'helpcenter' && <HelpcenterPage />}
      </div>
    </div>
  );
}

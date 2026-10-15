import { Users, Globe, Signature, Gauge } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/router';
import EmailAccountsSettingsPage from './accounts/page';
import MailDomainsSettingsPage from './domains/page';
import MailSignaturesSettingsPage from './signatures/page';
import MailSendingLimitsSettingsPage from './limits/page';
import { useMailSendingUsage } from '@/hooks/queries/use-mail-sending-queries';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { getTranslations } from '@/lib/i18n';

const TAB_VALUES = ['accounts', 'signatures', 'domains', 'limits'] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function WeldMailSettingsPage() {
  const ts = getTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();
  // The outbound guard's usage. A workspace it does not apply to (no data) gets no tab.
  const sendingUsage = useMailSendingUsage();
  const showLimits = sendingUsage.isLoading || Boolean(sendingUsage.data);

  const tabs: PageTab[] = [
    { id: 'accounts', label: ts.weldmail.tabs.accounts, icon: Users },
    { id: 'signatures', label: ts.weldmail.tabs.signatures, icon: Signature },
    { id: 'domains', label: ts.weldmail.tabs.domains, icon: Globe },
    ...(showLimits ? [{ id: 'limits', label: ts.weldmail.tabs.limits, icon: Gauge }] : []),
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
    const query = qs ? `?${qs}` : '';
    router.push(`/settings/apps/weldmail${query}`);
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
        {activeTab === 'signatures' && <MailSignaturesSettingsPage />}
        {activeTab === 'domains' && <MailDomainsSettingsPage />}
        {activeTab === 'limits' && <MailSendingLimitsSettingsPage />}
      </div>
    </div>
  );
}

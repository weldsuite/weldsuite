import { Megaphone, Link2, BarChart3 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  useWeldAdsConnections,
  useWeldAdsAccounts,
  useWeldAdsCampaigns,
} from '@/hooks/queries/use-weldads-queries';
import { KpiCardLink } from '@/components/kpi-card-link';

function useOverviewCounts() {
  const connections = useWeldAdsConnections();
  const accounts = useWeldAdsAccounts();
  const campaigns = useWeldAdsCampaigns({ limit: 1 });
  return {
    connections: connections.data?.length,
    accounts: accounts.data?.filter((a) => a.isSelected).length,
    campaigns: campaigns.data?.pagination?.totalCount,
    isLoading: connections.isLoading || accounts.isLoading || campaigns.isLoading,
  };
}

export default function WeldAdsOverviewPage() {
  const t = getTranslations('weldads').module;
  const counts = useOverviewCounts();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.overviewTitle}</h1>
        <p className="text-muted-foreground">{t.overviewDescription}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <KpiCardLink label={t.connected} value={counts.connections ?? '—'} href="/weldads/accounts" icon={Link2} />
        <KpiCardLink label={t.account} value={counts.accounts ?? '—'} href="/weldads/accounts" icon={BarChart3} />
        <KpiCardLink label={t.campaign} value={counts.campaigns ?? '—'} href="/weldads/campaigns" icon={Megaphone} />
      </div>
    </div>
  );
}

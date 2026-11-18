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
  // The ad accounts are read per connection, as the Ad accounts page does.
  const connectionId = connections.data?.[0]?.id;
  const accounts = useWeldAdsAccounts(connectionId);
  const campaigns = useWeldAdsCampaigns({ limit: 1 });
  return {
    connections: connections.data?.length ?? 0,
    // No connection means no ad accounts, not an unknown number of them.
    accounts: connectionId ? (accounts.data?.filter((a) => a.isSelected).length ?? 0) : 0,
    campaigns: campaigns.data?.pagination?.totalCount ?? 0,
    connectionsLoading: connections.isLoading,
    accountsLoading: connections.isLoading || accounts.isLoading,
    campaignsLoading: campaigns.isLoading,
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
        <KpiCardLink
          label={t.connections}
          value={counts.connections}
          loading={counts.connectionsLoading}
          href="/weldads/accounts"
          icon={Link2}
        />
        <KpiCardLink
          label={t.syncedAccounts}
          value={counts.accounts}
          loading={counts.accountsLoading}
          href="/weldads/accounts"
          icon={BarChart3}
        />
        <KpiCardLink
          label={t.campaignsTitle}
          value={counts.campaigns}
          loading={counts.campaignsLoading}
          href="/weldads/campaigns"
          icon={Megaphone}
        />
      </div>
    </div>
  );
}

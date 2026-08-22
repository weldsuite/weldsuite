import { Link } from '@/lib/router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Megaphone, Link2, BarChart3 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  useWeldAdsConnections,
  useWeldAdsAccounts,
  useWeldAdsCampaigns,
} from '@/hooks/queries/use-weldads-queries';

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

function StatCard({
  title,
  value,
  href,
  icon: Icon,
}: {
  title: string;
  value: number | undefined;
  href: string;
  icon: typeof Megaphone;
}) {
  return (
    <Link href={href}>
      <Card className="hover:bg-muted/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{value ?? '—'}</div>
        </CardContent>
      </Card>
    </Link>
  );
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
        <StatCard title={t.connected} value={counts.connections} href="/weldads/accounts" icon={Link2} />
        <StatCard title={t.account} value={counts.accounts} href="/weldads/accounts" icon={BarChart3} />
        <StatCard title={t.campaign} value={counts.campaigns} href="/weldads/campaigns" icon={Megaphone} />
      </div>
    </div>
  );
}

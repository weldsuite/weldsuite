'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import {
  useWeldAdsCampaigns,
  useWeldAdsConnections,
  useSyncWeldAdsConnection,
} from '@/hooks/queries/use-weldads-queries';

const STALE_MS = 60 * 60 * 1000;

export default function WeldAdsCampaignsPage() {
  const t = getTranslations('weldads').module;
  const campaigns = useWeldAdsCampaigns({ limit: 50 });
  const connections = useWeldAdsConnections();
  const syncConnection = useSyncWeldAdsConnection();
  const refreshedRef = useRef(false);

  const connection = connections.data?.[0];

  useEffect(() => {
    if (refreshedRef.current || !connection) return;
    const rows = campaigns.data?.data ?? [];
    const stale = rows.some((row) => {
      if (!row.metricsSyncedAt) return true;
      return Date.now() - new Date(row.metricsSyncedAt).getTime() > STALE_MS;
    });
    if (stale) {
      refreshedRef.current = true;
      syncConnection.mutate({ connectionId: connection.id, scope: 'metrics' });
    }
  }, [campaigns.data?.data, connection, syncConnection]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t.campaignsTitle}</h1>
          <p className="text-muted-foreground">{t.campaignsDescription}</p>
        </div>
        {connection && (
          <Button
            variant="outline"
            disabled={syncConnection.isPending}
            onClick={() => syncConnection.mutate({ connectionId: connection.id })}
          >
            {syncConnection.isPending ? t.refreshing : t.refresh}
          </Button>
        )}
      </div>

      {(campaigns.data?.data ?? []).length === 0 ? (
        <p className="text-muted-foreground">{t.noCampaigns}</p>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left p-3">{t.campaign}</th>
                <th className="text-left p-3">{t.account}</th>
                <th className="text-left p-3">{t.status}</th>
                <th className="text-right p-3">{t.spend}</th>
                <th className="text-right p-3">{t.impressions}</th>
                <th className="text-right p-3">{t.clicks}</th>
                <th className="text-right p-3">{t.ctr}</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns.data?.data ?? []).map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-medium">{row.name}</td>
                  <td className="p-3 text-muted-foreground">{row.accountName}</td>
                  <td className="p-3">{row.status ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.spend ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.impressions ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.clicks ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.ctr ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

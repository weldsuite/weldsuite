'use client';

import { useMemo, useState } from 'react';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { Megaphone, MoreHorizontal, Pause, Play, Pencil, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import {
  useWeldAdsAccounts,
  useWeldAdsCampaigns,
  useWeldAdsConnections,
  useSyncWeldAdsConnection,
  useUpdateWeldAdsCampaign,
  type AdCampaignRow,
} from '@/hooks/queries/use-weldads-queries';
import { CampaignFormDialog } from './campaign-form-dialog';

function campaignStatusLabel(status: string | null | undefined) {
  const statuses = getTranslations('weldads').statuses;
  if (!status) return '—';
  return statuses[status as keyof typeof statuses] ?? status;
}

function syncStatusLabel(status: AdCampaignRow['syncStatus']) {
  const t = getTranslations('weldads').module;
  if (!status) return '—';
  return t.syncStatuses[status] ?? status;
}

export default function WeldAdsCampaignsPage() {
  const t = getTranslations('weldads').module;
  const { can } = usePermissions();
  const canCreate = can('ad_campaigns:create');
  const canUpdate = can('ad_campaigns:update');

  const campaigns = useWeldAdsCampaigns({ limit: 50 });
  const connections = useWeldAdsConnections();
  const connection = connections.data?.[0];
  const accounts = useWeldAdsAccounts(connection?.id);
  const syncConnection = useSyncWeldAdsConnection();
  const updateCampaign = useUpdateWeldAdsCampaign();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<AdCampaignRow | null>(null);

  const selectedAccounts = useMemo(
    () => (accounts.data ?? []).filter((account) => account.isSelected),
    [accounts.data],
  );
  // Say why Create campaign is off, and where to fix it, once we know.
  const accountsKnown = !connections.isLoading && (!connection || !accounts.isLoading);
  const needsAccount = accountsKnown && selectedAccounts.length === 0;
  const needsAccountText = (
    <span id="weldads-needs-account">{connection ? t.noSelectedAccounts : t.noConnectionToCreate}</span>
  );
  const campaignRows = campaigns.data?.data ?? [];
  const accountsLink = (
    <Button asChild variant="outline" size="sm">
      <Link href="/weldads/accounts">{connection ? t.goToAccounts : t.connectFacebook}</Link>
    </Button>
  );

  const openCreateDialog = () => {
    setEditingCampaign(null);
    setDialogOpen(true);
  };

  const openEditDialog = (campaign: AdCampaignRow) => {
    setEditingCampaign(campaign);
    setDialogOpen(true);
  };

  useCreateIntent(openCreateDialog, { ready: canCreate && selectedAccounts.length > 0 });

  const handleStatusChange = async (campaign: AdCampaignRow, status: 'ACTIVE' | 'PAUSED') => {
    try {
      await updateCampaign.mutateAsync({ id: campaign.id, status });
      toast.success(status === 'PAUSED' ? t.pauseSuccess : t.activateSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.saveError);
    }
  };

  const handleSync = async () => {
    if (!connection) return;
    try {
      await syncConnection.mutateAsync({ connectionId: connection.id, scope: 'full' });
      toast.success(t.syncSuccess);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.saveError);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t.campaignsTitle}</h1>
          <p className="text-muted-foreground">{t.campaignsDescription}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <Button
              onClick={openCreateDialog}
              disabled={selectedAccounts.length === 0}
              aria-describedby={needsAccount ? 'weldads-needs-account' : undefined}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t.createCampaign}
            </Button>
          )}
          {connection && (
            <Button
              variant="outline"
              disabled={syncConnection.isPending}
              onClick={handleSync}
            >
              {syncConnection.isPending ? t.syncing : t.syncNow}
            </Button>
          )}
        </div>
      </div>

      {canCreate && needsAccount && campaignRows.length > 0 && (
        <InfoBanner variant="neutral" action={accountsLink}>
          {needsAccountText}
        </InfoBanner>
      )}

      {campaignRows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={t.noCampaigns}
          description={needsAccount ? needsAccountText : undefined}
          action={needsAccount ? accountsLink : undefined}
        />
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left p-3">{t.campaign}</th>
                <th className="text-left p-3">{t.account}</th>
                <th className="text-left p-3">{t.status}</th>
                <th className="text-left p-3">{t.syncStatus}</th>
                <th className="text-right p-3">{t.spend}</th>
                <th className="text-right p-3">{t.impressions}</th>
                <th className="text-right p-3">{t.clicks}</th>
                <th className="text-right p-3">{t.ctr}</th>
                {canUpdate && <th className="text-right p-3">{t.actions}</th>}
              </tr>
            </thead>
            <tbody>
              {campaignRows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-medium">{row.name}</td>
                  <td className="p-3 text-muted-foreground">{row.accountName}</td>
                  <td className="p-3">{campaignStatusLabel(row.status)}</td>
                  <td className="p-3">
                    <span title={row.syncError ?? undefined}>{syncStatusLabel(row.syncStatus)}</span>
                  </td>
                  <td className="p-3 text-right">{row.metrics?.spend ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.impressions ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.clicks ?? '—'}</td>
                  <td className="p-3 text-right">{row.metrics?.ctr ?? '—'}</td>
                  {canUpdate && (
                    <td className="p-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={t.actions}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(row)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            {t.editCampaign}
                          </DropdownMenuItem>
                          {row.status === 'ACTIVE' ? (
                            <DropdownMenuItem onClick={() => handleStatusChange(row, 'PAUSED')}>
                              <Pause className="mr-2 h-4 w-4" />
                              {t.pauseCampaign}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => handleStatusChange(row, 'ACTIVE')}>
                              <Play className="mr-2 h-4 w-4" />
                              {t.activateCampaign}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CampaignFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        accounts={accounts.data ?? []}
        campaign={editingCampaign}
      />
    </div>
  );
}

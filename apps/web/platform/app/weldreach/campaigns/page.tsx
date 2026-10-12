/**
 * WeldReach campaigns: the list is the whole page, its top bar carries the
 * search, the status filter and "New campaign"; the breadcrumb is the title.
 */

import { useMemo, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  reachCampaignStatusSchema,
  type ReachCampaign,
  type ReachCampaignStatus,
} from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useRouter } from '@/lib/router';
import {
  useDeleteReachCampaign,
  useReachCampaigns,
} from '@/hooks/queries/use-reach-campaign-queries';
import { CampaignStatusBadge, campaignStatusKey } from '@/app/weldreach/components/engage/badges';
import { RelativeTime, useReachFormat } from '@/app/weldreach/components/engage/format';
import { selectFilterConfig, useSelectFilter } from '@/app/weldreach/components/engage/filters';
import {
  FilterSelect,
  emptyIcon,
  errorMessage,
  useReachBreadcrumbs,
} from '@/app/weldreach/components/engage/kit';
import { CreateCampaignDialog } from './components/create-campaign-dialog';

const STATUS_FILTER_OPTIONS = reachCampaignStatusSchema.options;

export default function ReachCampaignsPage() {
  const t = useTranslations();
  const router = useRouter();
  const format = useReachFormat();
  const { can } = usePermissions();
  useReachBreadcrumbs({ label: t('reachEngage.campaigns.title') });

  const statusFilter = useSelectFilter('status');
  const status = statusFilter.value as ReachCampaignStatus | undefined;
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ReachCampaign | null>(null);

  const query = useReachCampaigns(status);
  // "is not" has no server counterpart: it hides rows already loaded.
  const campaigns = useMemo(
    () => query.campaigns.filter((campaign) => campaign.status !== statusFilter.excluded),
    [query.campaigns, statusFilter.excluded],
  );
  const deleteCampaign = useDeleteReachCampaign();

  const canCreate = can('reach_campaigns:create');
  const canDelete = can('reach_campaigns:delete');

  const openCampaign = (campaign: ReachCampaign) =>
    router.push(`/weldreach/campaigns/${campaign.id}`);

  async function confirmDelete(campaign: ReachCampaign) {
    try {
      await deleteCampaign.mutateAsync(campaign.id);
      toast.success(t('reachEngage.campaigns.delete.done', { name: campaign.name }));
    } catch (err) {
      toast.error(errorMessage(err, t('reachEngage.campaigns.delete.failed')));
    } finally {
      setDeleting(null);
    }
  }

  const number = (value: number) => (
    <span className="tabular-nums">{format.number(value)}</span>
  );

  const columns: ColumnDef<ReachCampaign>[] = [
    {
      id: 'name',
      header: t('reachEngage.campaigns.table.name'),
      width: 'flex-1',
      render: (campaign) => <span className="block truncate font-medium">{campaign.name}</span>,
    },
    {
      id: 'status',
      header: t('reachEngage.campaigns.table.status'),
      width: 'w-[110px]',
      render: (campaign) => <CampaignStatusBadge status={campaign.status} />,
    },
    {
      id: 'prospects',
      header: t('reachEngage.campaigns.table.prospects'),
      width: 'hidden md:block md:w-[90px]',
      headerClassName: 'md:text-right',
      render: (campaign) => <div className="text-right">{number(campaign.stats.prospects)}</div>,
    },
    {
      id: 'sent',
      header: t('reachEngage.campaigns.table.sent'),
      width: 'hidden md:block md:w-[80px]',
      headerClassName: 'md:text-right',
      render: (campaign) => <div className="text-right">{number(campaign.stats.sent)}</div>,
    },
    {
      id: 'replied',
      header: t('reachEngage.campaigns.table.replied'),
      width: 'hidden lg:block lg:w-[80px]',
      headerClassName: 'lg:text-right',
      render: (campaign) => <div className="text-right">{number(campaign.stats.replied)}</div>,
    },
    {
      id: 'interested',
      header: t('reachEngage.campaigns.table.interested'),
      width: 'hidden lg:block lg:w-[90px]',
      headerClassName: 'lg:text-right',
      render: (campaign) => <div className="text-right">{number(campaign.stats.interested)}</div>,
    },
    {
      id: 'bounced',
      header: t('reachEngage.campaigns.table.bounced'),
      width: 'hidden lg:block lg:w-[80px]',
      headerClassName: 'lg:text-right',
      render: (campaign) => <div className="text-right">{number(campaign.stats.bounced)}</div>,
    },
    {
      id: 'updated',
      header: t('reachEngage.campaigns.table.updated'),
      width: 'hidden md:block md:w-[130px]',
      render: (campaign) => (
        <RelativeTime value={campaign.updatedAt} className="text-sm text-muted-foreground" />
      ),
    },
  ];

  const statusOptions = STATUS_FILTER_OPTIONS.map((value) => ({
    value,
    label: t(campaignStatusKey(value)),
  }));
  const isFiltered = status !== undefined || statusFilter.excluded !== undefined;

  return (
    <>
      <PanelEntityList<ReachCampaign>
        items={campaigns}
        isLoading={query.isLoading}
        error={query.error}
        columns={columns}
        onRowClick={openCampaign}
        onDelete={canDelete ? (campaign) => setDeleting(campaign) : undefined}
        searchFields={['name']}
        searchPlaceholder={t('reachEngage.campaigns.searchPlaceholder')}
        filters={[selectFilterConfig('status', t('reachEngage.campaigns.table.status'), statusOptions)]}
        activeFilters={statusFilter.filters}
        onFiltersChange={statusFilter.setFilters}
        // The filter pills are hidden on small screens, so a plain select stands in there.
        actionButtons={
          <FilterSelect
            value={status}
            onChange={statusFilter.setValue}
            options={statusOptions}
            allLabel={t('reachEngage.campaigns.allStatuses')}
            ariaLabel={t('reachEngage.campaigns.statusFilter')}
            className="md:hidden"
          />
        }
        createButton={
          canCreate
            ? { label: t('reachEngage.campaigns.newCampaign'), onClick: () => setCreating(true) }
            : undefined
        }
        hasMore={query.hasNextPage}
        isLoadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        emptyState={{
          icon: emptyIcon(Megaphone),
          title: isFiltered
            ? t('reachEngage.campaigns.noResultsTitle')
            : t('reachEngage.campaigns.emptyTitle'),
          description: isFiltered
            ? t('reachEngage.campaigns.noResultsDescription')
            : t('reachEngage.campaigns.emptyDescription'),
          action:
            canCreate && !isFiltered
              ? { label: t('reachEngage.campaigns.emptyAction'), onClick: () => setCreating(true) }
              : undefined,
        }}
        noResultsState={{
          title: t('reachEngage.campaigns.noResultsTitle'),
          description: t('reachEngage.campaigns.noResultsDescription'),
        }}
      />

      {creating && (
        <CreateCampaignDialog
          onClose={() => setCreating(false)}
          onCreated={(campaignId) => {
            setCreating(false);
            router.push(`/weldreach/campaigns/${campaignId}`);
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('reachEngage.campaigns.delete.title')}
        description={t('reachEngage.campaigns.delete.description', { name: deleting?.name ?? '' })}
        confirmLabel={t('reachEngage.common.delete')}
        cancelLabel={t('reachEngage.common.cancel')}
        variant="destructive"
        onConfirm={() => (deleting ? confirmDelete(deleting) : undefined)}
      />
    </>
  );
}

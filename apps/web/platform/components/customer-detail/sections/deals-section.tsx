
/**
 * The deals of a company or person, as the panel's Deals tab: the standard
 * `EntityList` with `TabListRow` rows, grouped open / won / lost with each
 * group's total in its header. Clicking a row opens the deal's panel.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DealsSectionProps, Opportunity } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
  type HeaderColumn,
} from '@/components/entity-list';
import { applySelectFilters } from '@/lib/list-filters';
import { useObjectPanel } from '@/components/object-panel';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { DealDetailsModal } from '@/components/weldcrm/pipeline/deal-details-modal';
import { usePipelines, usePipelineStages } from '@/hooks/queries/use-pipelines-queries';
import { useCreateOpportunity } from '@/hooks/queries/use-opportunities-queries';
import { useCompany } from '@/components/objects/company/use-company-data';
import { DealsIllustration, TAB_EMPTY_STATE_TABLE_CLASS } from '@/components/objects/_shared/tab-empty-state';
import {
  dominantCurrency,
  formatDealDate,
  formatDealMoney,
  formatDealTotals,
} from '@/lib/crm/deal-format';

type DealBucket = 'open' | 'won' | 'lost';

const BUCKETS: DealBucket[] = ['open', 'won', 'lost'];

const BUCKET_LABEL: Record<DealBucket, string> = {
  open: 'sweep.entities.statusOpen',
  won: 'sweep.entities.statusWon',
  lost: 'sweep.entities.statusLost',
};

function dealBucket(deal: Opportunity): DealBucket {
  return deal.status === 'won' || deal.status === 'lost' ? deal.status : 'open';
}

type DealListItem = Opportunity & {
  /** Flattened for the list's search and filters. */
  title: string;
  stageLabel: string;
  bucket: DealBucket;
};

const COLUMN = {
  name: 'min-w-0 flex-1',
  stage: 'w-[140px] min-w-0 @max-[560px]:hidden',
  amount: 'w-[120px] min-w-0 @max-[560px]:w-[90px]',
  probability: 'w-[100px] @max-[820px]:hidden',
  closeDate: 'w-[120px] @max-[820px]:hidden',
};

const stageColors: Record<string, string> = {
  lead: 'bg-muted text-foreground',
  qualified: 'bg-blue-100 text-blue-700',
  proposal: 'bg-purple-100 text-purple-700',
  negotiation: 'bg-orange-100 text-orange-700',
  closed_won: 'bg-green-100 text-green-700',
  closed_lost: 'bg-red-100 text-red-700',
};

/** Won/lost deals read green/red regardless of what their stage is called. */
function statusBadgeClass(status: string): string | undefined {
  if (status === 'won') return 'bg-green-100 text-green-700';
  if (status === 'lost') return 'bg-red-100 text-red-700';
  return undefined;
}

function dealAmount(deal: Opportunity): number {
  const parsed = deal.amount ? Number.parseFloat(deal.amount) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : deal.value || 0;
}

/**
 * Sum deals per currency and format each total in its own currency
 * ("€1,200 + $500"). Adding amounts of different currencies into one number
 * and labelling it with a single symbol is wrong. A group with no deals (no
 * won deals yet) shows its zero in `emptyCurrency` — the currency of the
 * company's other deals — so "Won" doesn't read €0 beside "$5,300".
 */
function formatTotals(deals: Opportunity[], emptyCurrency: string): string {
  return formatDealTotals(
    deals.map((deal) => ({ amount: dealAmount(deal), currency: deal.currency })),
    { emptyCurrency },
  );
}

export function DealsSection({
  opportunities,
  customer,
  entityKind = 'company',
  isLoading = false,
}: Readonly<DealsSectionProps & { entityKind?: 'company' | 'person'; isLoading?: boolean }>) {
  const t = useTranslations();
  const { open: openPanel } = useObjectPanel();
  const [createDealOpen, setCreateDealOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const createOpportunityMutation = useCreateOpportunity();
  const qc = useQueryClient();

  // Resolve the real company name for the locked-customer create-deal
  // dialog — `customer` here is often just `{ id }` (DealsTab passes a stub
  // for the panel's Deals tab). Quietly 404s when this is actually a
  // person id (Person tab), in which case the dialog falls back to an
  // unlocked customer picker.
  const companyQuery = useCompany(customer.id, !!customer.id);
  const company = companyQuery.data?.data;
  const lockedCustomer = useMemo(
    () => (company ? { id: company.id, name: company.displayName || company.name } : undefined),
    [company],
  );

  // Stages for the create-deal dialog — same dialog the pipeline board
  // uses, seeded from the workspace's default pipeline.
  const { data: pipelinesResult } = usePipelines();
  const defaultPipeline = pipelinesResult?.data?.find((p) => p.isDefault) ?? pipelinesResult?.data?.[0];
  const { data: stagesResult } = usePipelineStages(defaultPipeline?.id);
  const dealStages = useMemo(
    () => [...(stagesResult?.data ?? [])].sort((a, b) => a.position - b.position),
    [stagesResult],
  );
  // Deals can sit in any pipeline, so resolve a deal's stage name from every
  // stage, not just the default pipeline's (which feeds the create dialog).
  const { data: allStagesResult } = usePipelineStages(undefined);
  const stagesById = useMemo(
    () => new Map([...(allStagesResult?.data ?? []), ...dealStages].map((s) => [s.id, s])),
    [allStagesResult, dealStages],
  );
  const firstOpenStage = dealStages.find((s) => !s.isWon && !s.isLost) ?? dealStages[0];
  const pipelineCurrency = (defaultPipeline?.settings as { defaultCurrency?: string } | undefined)?.defaultCurrency;

  const handleCreateDeal = async (data: Record<string, unknown>) => {
    try {
      await createOpportunityMutation.mutateAsync({
        ...data,
        pipeline: defaultPipeline?.id,
      });
      // The customer-deals list has its own query key family, separate from
      // `opportunityKeys` — the realtime topic eventually catches up, but
      // invalidate directly so the tab reflects the new deal immediately.
      qc.invalidateQueries({ queryKey: ['crm', 'customer-deals'] });
      toast.success(t('sweep.weldcrm.dealsSection.dealCreated'));
    } catch (error) {
      console.error('Failed to create deal:', error);
      toast.error(t('sweep.weldcrm.dealsSection.dealCreateFailed'));
      throw error;
    }
  };

  const createDealDialog = firstOpenStage ? (
    <DealDetailsModal
      open={createDealOpen}
      onOpenChange={setCreateDealOpen}
      stages={dealStages.map((s) => ({ id: s.id, name: s.name, color: s.color || undefined }))}
      selectedStageId={firstOpenStage.id}
      onSubmit={handleCreateDeal}
      lockedCustomer={lockedCustomer}
      defaultCurrency={pipelineCurrency}
    />
  ) : null;

  const items = useMemo<DealListItem[]>(
    () =>
      opportunities.map((deal) => {
        // Prefer the real pipeline stage's name (resolved via `stageId`) over the
        // legacy free-text `stage` id, which used to render raw (e.g.
        // "pls_abc123" instead of "Negotiation").
        const pipelineStage = deal.stageId ? stagesById.get(deal.stageId) : undefined;
        return {
          ...deal,
          title: deal.name || deal.title || '',
          stageLabel: pipelineStage?.name ?? (deal.stage || 'lead').replace('_', ' '),
          bucket: dealBucket(deal),
        };
      }),
    [opportunities, stagesById],
  );

  const filterConfigs = useMemo<FilterConfig[]>(() => {
    const stages = [...new Set(items.map((d) => d.stageLabel))].sort((x, y) => x.localeCompare(y));
    return [
      {
        field: 'status',
        label: t('sweep.entities.fieldStatus'),
        options: BUCKETS.map((bucket) => ({ value: bucket, label: t(BUCKET_LABEL[bucket]) })),
      },
      {
        field: 'stage',
        label: t('sweep.entities.fieldStage'),
        options: stages.map((stage) => ({ value: stage, label: stage })),
      },
    ];
  }, [items, t]);

  // Search and filters are applied here rather than inside the list, so the
  // totals in the group headers add up the deals that are actually shown.
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const searched = query
      ? items.filter((d) => d.title.toLowerCase().includes(query) || d.stageLabel.toLowerCase().includes(query))
      : items;
    return applySelectFilters(searched, activeFilters, {
      status: (d, value) => d.bucket === value,
      stage: (d, value) => d.stageLabel === value,
    });
  }, [items, search, activeFilters]);

  // Open / won / lost by the deal's real `status`, not the legacy free-text
  // `stage`. Each group's total is formatted per currency because deals may
  // carry different ones; a zero shows in the currency the other deals use.
  const groups = useMemo<GroupConfig<DealListItem>[]>(() => {
    const emptyCurrency = dominantCurrency(opportunities);
    return BUCKETS.map((bucket, index) => ({
      id: bucket,
      label: t(BUCKET_LABEL[bucket]),
      sortOrder: index + 1,
      filter: (d: DealListItem) => d.bucket === bucket,
      rightContent: (
        <span className={cn('text-xs font-mono', bucket === 'won' ? 'text-green-600' : 'text-muted-foreground')}>
          {formatTotals(visible.filter((d) => d.bucket === bucket), emptyCurrency)}
        </span>
      ),
    }));
  }, [opportunities, visible, t]);

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'name', header: t('sweep.entities.fieldName'), width: COLUMN.name },
      { id: 'stage', header: t('sweep.entities.fieldStage'), width: COLUMN.stage },
      { id: 'amount', header: t('sweep.entities.fieldAmount'), width: COLUMN.amount },
      { id: 'probability', header: t('sweep.entities.fieldProbability'), width: COLUMN.probability },
      { id: 'closeDate', header: t('sweep.entities.fieldCloseDate'), width: COLUMN.closeDate },
    ],
    [t],
  );

  const renderRow = useCallback(
    (deal: DealListItem) => {
      const openDeal = () => openPanel({ type: 'opportunity', id: deal.id, stack: true });
      const closeDate = deal.closeDate ?? deal.expectedCloseDate;
      return (
        <TabListRow
          key={deal.id}
          label={deal.title}
          onOpen={openDeal}
          menuLabel={t('sweep.entities.moreActions')}
          menu={
            <DropdownMenuItem onClick={openDeal}>
              <ExternalLink />
              {t('sweep.weldcrm.dealsSection.viewDeal')}
            </DropdownMenuItem>
          }
        >
          <div className={COLUMN.name}>
            <span className="block truncate text-sm font-medium text-foreground">{deal.title}</span>
          </div>
          <div className={COLUMN.stage}>
            <span
              className={cn(
                'inline-flex items-center max-w-full h-[22px] px-2 rounded text-[12px] font-medium leading-none capitalize',
                statusBadgeClass(deal.status) ?? stageColors[deal.stage || 'lead'] ?? 'bg-muted text-foreground',
              )}
            >
              <span className="truncate">{deal.stageLabel}</span>
            </span>
          </div>
          <div className={COLUMN.amount}>
            <span className="block truncate text-sm text-foreground">
              {formatDealMoney(dealAmount(deal), deal.currency)}
            </span>
          </div>
          <div className={COLUMN.probability}>
            <span className="text-sm text-muted-foreground">
              {typeof deal.probability === 'number' && deal.probability > 0 ? `${deal.probability}%` : '—'}
            </span>
          </div>
          <div className={COLUMN.closeDate}>
            <span className="text-sm text-muted-foreground">{(closeDate && formatDealDate(closeDate)) || '—'}</span>
          </div>
        </TabListRow>
      );
    },
    [openPanel, t],
  );

  const openCreateDeal = () => {
    if (firstOpenStage) setCreateDealOpen(true);
  };

  return (
    <TabListScope>
      <EntityList<DealListItem>
        items={visible}
        isLoading={isLoading}
        error={null}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        groups={groups}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={t('sweep.entities.searchDealsPlaceholder')}
        searchFields={['title']}
        searchQuery={search}
        onSearchChange={setSearch}
        createButton={{
          label: t('sweep.weldcrm.dealsSection.newDeal'),
          onClick: openCreateDeal,
        }}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <DealsIllustration />,
          title: t('sweep.weldcrm.dealsSection.noDealsYet'),
          description: t(
            entityKind === 'person'
              ? 'sweep.weldcrm.dealsSection.noDealsYetDescriptionPerson'
              : 'sweep.weldcrm.dealsSection.noDealsYetDescription',
          ),
          action: {
            label: t('sweep.weldcrm.dealsSection.createDeal'),
            onClick: openCreateDeal,
          },
        }}
        noResultsState={{
          title: t('sweep.entities.noDealsFoundTitle'),
          description: t('sweep.entities.noDealsFoundDescription'),
        }}
        dialogComponent={createDealDialog}
      />
    </TabListScope>
  );
}

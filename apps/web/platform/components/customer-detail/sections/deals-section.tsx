
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Handshake, Plus, MoreHorizontal, Banknote, Calendar, TrendingUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DealsSectionProps, Opportunity } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@weldsuite/i18n/provider';
import { DealDetailsModal } from '@/components/weldcrm/pipeline/deal-details-modal';
import { usePipelines, usePipelineStages, type PipelineStage } from '@/hooks/queries/use-pipelines-queries';
import { useCreateOpportunity } from '@/hooks/queries/use-opportunities-queries';
import { useCompany } from '@/components/objects/company/use-company-data';
import {
  dominantCurrency,
  formatDealDate,
  formatDealMoney,
  formatDealTotals,
} from '@/lib/crm/deal-format';

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

/** Deal-count label, pluralised per locale ("1 deal" / "3 deals"). */
function useDealCountLabel() {
  const t = useTranslations();
  const { plural } = useI18n();
  return (count: number) =>
    plural(count, {
      one: t('sweep.weldcrm.dealsSection.dealCountOne'),
      other: t('sweep.weldcrm.dealsSection.dealCount'),
    });
}

export function DealsSection({
  opportunities,
  totalCount,
  customer,
  entityKind = 'company',
}: Readonly<DealsSectionProps & { entityKind?: 'company' | 'person' }>) {
  const t = useTranslations();
  const dealCountLabel = useDealCountLabel();
  const [createDealOpen, setCreateDealOpen] = useState(false);
  const createOpportunityMutation = useCreateOpportunity();
  const qc = useQueryClient();

  // Resolve the real company name for the locked-customer create-deal
  // dialog — `customer` here is often just `{ id }` (DealsTab passes a stub
  // for the panel's Pipeline tab). Quietly 404s when this is actually a
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

  if (opportunities.length === 0) {
    return (
      <div className="text-center py-12">
        <Handshake className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-foreground mb-2">{t('sweep.weldcrm.dealsSection.noDealsYet')}</h3>
        <p className="text-sm text-muted-foreground mb-4">
          {t(
            entityKind === 'person'
              ? 'sweep.weldcrm.dealsSection.noDealsYetDescriptionPerson'
              : 'sweep.weldcrm.dealsSection.noDealsYetDescription',
          )}
        </p>
        <Button className="gap-1.5" disabled={!firstOpenStage} onClick={() => setCreateDealOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('sweep.weldcrm.dealsSection.createDeal')}
        </Button>
        {createDealDialog}
      </div>
    );
  }

  // Classify by the deal's real `status` (open / won / lost), not the legacy
  // free-text `stage`, which is a stage id for stage-based deals. Totals are
  // formatted per currency because deals may carry different ones.
  const openDeals = opportunities.filter((o) => o.status === 'open');
  const wonDeals = opportunities.filter((o) => o.status === 'won');
  // A group with no deals shows its zero in the currency the rest of the
  // company's deals use, not a fixed default.
  const emptyCurrency = dominantCurrency(opportunities);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 mb-6">
        <h2 className="text-lg font-medium text-foreground">{t('sweep.weldcrm.dealsSection.deals')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{dealCountLabel(totalCount)}</span>
          <Button size="sm" className="gap-1.5" disabled={!firstOpenStage} onClick={() => setCreateDealOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.dealsSection.newDeal')}
          </Button>
        </div>
      </div>

      {/* Summary Cards. Auto-fit columns: three across when there is room
          (fullscreen), wrapping to two / one in the 400px side panel instead
          of clipping the last card. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3 mb-6">
        <div className="min-w-0 bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <TrendingUp className="h-4 w-4 shrink-0" />
            <span className="text-sm truncate">{t('sweep.weldcrm.dealsSection.openPipeline')}</span>
          </div>
          <p className="text-xl font-semibold text-foreground break-words">
            {formatTotals(openDeals, emptyCurrency)}
          </p>
          <p className="text-xs text-muted-foreground">{dealCountLabel(openDeals.length)}</p>
        </div>

        <div className="min-w-0 bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Banknote className="h-4 w-4 shrink-0" />
            <span className="text-sm truncate">{t('sweep.weldcrm.dealsSection.won')}</span>
          </div>
          <p className="text-xl font-semibold text-green-600 break-words">
            {formatTotals(wonDeals, emptyCurrency)}
          </p>
          <p className="text-xs text-muted-foreground">{dealCountLabel(wonDeals.length)}</p>
        </div>

        <div className="min-w-0 bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Handshake className="h-4 w-4 shrink-0" />
            <span className="text-sm truncate">{t('sweep.weldcrm.dealsSection.totalValue')}</span>
          </div>
          <p className="text-xl font-semibold text-foreground break-words">
            {formatTotals(opportunities, emptyCurrency)}
          </p>
          <p className="text-xs text-muted-foreground">{dealCountLabel(totalCount)}</p>
        </div>
      </div>

      {/* Deals List */}
      <div className="space-y-2">
        {opportunities.map((deal) => (
          <DealCard key={deal.id} deal={deal} stage={deal.stageId ? stagesById.get(deal.stageId) : undefined} />
        ))}
      </div>
      {createDealDialog}
    </div>
  );
}

function DealCard({ deal, stage: pipelineStage }: Readonly<{ deal: Opportunity; stage?: PipelineStage }>) {
  const t = useTranslations();
  const value = dealAmount(deal);
  const stage = deal.stage || 'lead';
  const closeDate = deal.closeDate ?? deal.expectedCloseDate;
  // Prefer the real pipeline stage's name (resolved via `stageId`) over the
  // legacy free-text `stage` id, which used to render raw (e.g. "pls_abc123"
  // instead of "Negotiation").
  const stageLabel = pipelineStage?.name ?? stage.replace('_', ' ');

  return (
    <div className="flex items-center gap-4 p-4 bg-background border border-border rounded-lg hover:border-border transition-colors group">
      {/* Deal Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="min-w-0 truncate font-medium text-foreground">{deal.name || deal.title}</span>
          <span className={cn(
            "shrink-0 text-xs px-2 py-0.5 rounded-full",
            statusBadgeClass(deal.status) ?? stageColors[stage] ?? 'bg-muted text-foreground'
          )}>
            {stageLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {formatDealMoney(value, deal.currency)}
          </span>
          {typeof deal.probability === 'number' && deal.probability > 0 && (
            <>
              <span>·</span>
              <span>{t('sweep.weldcrm.dealsSection.probability', { percent: deal.probability })}</span>
            </>
          )}
          {closeDate && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {t('sweep.weldcrm.dealsSection.closeDate', { date: formatDealDate(closeDate) ?? '' })}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.viewDeal')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.editDeal')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.addActivity')}</DropdownMenuItem>
          <DropdownMenuItem className="text-green-600">{t('sweep.weldcrm.dealsSection.markAsWon')}</DropdownMenuItem>
          <DropdownMenuItem className="text-red-600">{t('sweep.weldcrm.dealsSection.markAsLost')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

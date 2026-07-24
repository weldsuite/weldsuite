
import { useState, useEffect, useMemo, useCallback } from 'react';
import { PipelineKanban } from '@/components/weldcrm/pipeline/pipeline-kanban';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Pipeline, PipelineStage } from '@/hooks/queries/use-pipelines-queries';
import { useCreateOpportunity, useUpdateOpportunityStage } from '@/hooks/queries/use-opportunities-queries';
import type { Opportunity as DomainOpportunity } from '@/lib/api/domains/weldcrm';
import { useWorkspace } from '@/contexts/workspace-context';
import { Loader2, ChevronRight, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { useCustomerDetailContextSafe } from '../customer-detail-provider';
import type { Customer, Opportunity } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

interface DealsPipelineSectionProps {
  customer: Customer;
  opportunities: Opportunity[];
}

/**
 * Minimal customer/company shape used by `PipelineKanban`'s `customers` and
 * `lockedCustomer` props — that component's own prop types are untyped
 * (`any`) at the source, so this is defined locally from actual usage here.
 */
interface PipelineCustomer {
  id: string;
  companyName?: string;
  tradingName?: string;
  fullName?: string;
  email?: string;
  name?: string;
}

/** Payload `PipelineKanban`'s deal-creation form submits. */
interface DealCreateData {
  name: string;
  customerId: string;
  amount: number;
  probability?: number;
  closeDate?: string;
  description?: string;
  status: 'open';
  stageId: string;
  companyId?: string;
}

interface PipelineRow {
  id: string;
  name: string;
  color?: string;
  stages: PipelineStage[];
  opportunities: Opportunity[];
  dealCount: number;
  totalValue: number;
}

function mapOpportunityToDeal(opp: Opportunity, customer: Customer) {
  return {
    id: opp.id,
    title: opp.name,
    value: opp.amount ? parseFloat(opp.amount) : 0,
    stage: opp.stage,
    company: {
      id: customer.id,
      name: customer.companyName || customer.tradingName || customer.fullName || customer.email,
    },
    contact: opp.primaryContactId ? {
      id: opp.primaryContactId,
      name: '',
      email: '',
    } : undefined,
    probability: opp.probability || 0,
    expectedCloseDate: opp.closeDate,
    tags: opp.tags || [],
    status: opp.status,
    notes: opp.description,
  };
}

const COLOR_MAP: Record<string, string> = {
  'bg-violet-500': 'bg-violet-500',
  'bg-blue-500': 'bg-blue-500',
  'bg-green-500': 'bg-green-500',
  'bg-red-500': 'bg-red-500',
  'bg-yellow-500': 'bg-yellow-500',
  'bg-orange-500': 'bg-orange-500',
  'bg-pink-500': 'bg-pink-500',
  'bg-cyan-500': 'bg-cyan-500',
  'bg-emerald-500': 'bg-emerald-500',
  'bg-indigo-500': 'bg-indigo-500',
  'bg-gray-500': 'bg-gray-500',
};

function getColorClass(color?: string): string {
  if (!color) return 'bg-violet-500';
  return COLOR_MAP[color] || color || 'bg-violet-500';
}

function formatCurrency(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(value);
}

export function DealsPipelineSection({ customer, opportunities }: DealsPipelineSectionProps) {
  const t = useTranslations();
  const { currentWorkspace } = useWorkspace();
  const ctx = useCustomerDetailContextSafe();
  const { getClient } = useAppApiClient();
  const createOpportunityMutation = useCreateOpportunity();
  const updateOpportunityStageMutation = useUpdateOpportunityStage();
  const [pipelineGroups, setPipelineGroups] = useState<PipelineRow[]>([]);
  const [customers, setCustomers] = useState<PipelineCustomer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const client = await getClient();
        const [pipelinesResult, customersResult] = await Promise.all([
          client.get<{ data?: Pipeline[] }>('/pipelines'),
          client.get<{ data?: PipelineCustomer[] }>('/companies?limit=50'),
        ]);

        const customersList = customersResult.data || [];
        setCustomers(customersList);

        // Group opportunities by pipeline
        const pipelineMap = new Map<string, Opportunity[]>();
        for (const opp of opportunities) {
          const pipelineId = opp.pipeline || 'default';
          if (!pipelineMap.has(pipelineId)) {
            pipelineMap.set(pipelineId, []);
          }
          pipelineMap.get(pipelineId)!.push(opp);
        }

        // Fetch stages for each pipeline that has deals
        const pipelineIds = Array.from(pipelineMap.keys());
        const stagesResults = await Promise.all(
          pipelineIds.map((id) =>
            client.get<{ data?: PipelineStage[] }>(`/pipeline-stages?pipeline=${encodeURIComponent(id)}`),
          ),
        );

        // Build pipeline info
        const pipelines = pipelinesResult.data || [];
        const groups: PipelineRow[] = pipelineIds.map((pipelineId, idx) => {
          const pipelineData = pipelines.find((p) => p.id === pipelineId);
          const stagesResult = stagesResults[idx];
          const stagesList = stagesResult.data || [];
          const stageIds = new Set(stagesList.map((s) => s.id));
          const opps = pipelineMap.get(pipelineId) || [];
          // Only count deals that have a matching stage in this pipeline
          const matchedOpps = opps.filter(opp => stageIds.has(opp.stage));
          const totalValue = matchedOpps.reduce(
            (sum, opp) => sum + (opp.amount ? parseFloat(opp.amount) : 0), 0
          );
          return {
            id: pipelineId,
            name: pipelineData?.name || t('sweep.weldcrm.dealsPipelineSection.defaultPipeline'),
            color: pipelineData?.color,
            stages: stagesList,
            opportunities: matchedOpps,
            dealCount: matchedOpps.length,
            totalValue,
          };
        }).filter(g => g.dealCount > 0);

        setPipelineGroups(groups);
        const totalDeals = groups.reduce((sum, g) => sum + g.dealCount, 0);
        ctx?.setCountOverride('opportunities', totalDeals);
      } catch (error) {
        console.error('Failed to fetch pipeline data:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    // `ctx` (from useCustomerDetailContextSafe) is a fresh object every render —
    // depending on it would re-run this fetch (and its ctx.setCountOverride call)
    // in a render loop. Read the latest value via closure instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunities, getClient, t]);

  const lockedCustomer = useMemo(() => ({
    id: customer.id,
    name: customer.companyName || customer.tradingName || customer.fullName || customer.email,
  }), [customer]);

  const handleDealMove = useCallback(async (dealId: string, _fromStage: string, toStage: string) => {
    if (!currentWorkspace) return;
    await updateOpportunityStageMutation.mutateAsync({ id: dealId, stage: toStage, stageId: toStage });
  }, [currentWorkspace, updateOpportunityStageMutation]);

  const handleDealCreate = useCallback(async (data: DealCreateData) => {
    if (!currentWorkspace) return;
    // `amount` arrives as a number from the deal form; `Opportunity.amount` is
    // a string on the wire (decimal-as-string). Cast at the boundary rather
    // than reshaping the payload — this mirrors the pre-existing (untyped)
    // behavior of sending the raw form data straight to the mutation.
    const payload = {
      ...data,
      companyId: data.companyId || customer.id,
    };
    await createOpportunityMutation.mutateAsync(payload as unknown as Partial<DomainOpportunity>);
  }, [currentWorkspace, customer.id, createOpportunityMutation]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.transcriptTab.loading')}</span>
      </div>
    );
  }

  // Single pipeline → show kanban directly
  if (pipelineGroups.length <= 1) {
    const group = pipelineGroups[0];
    const deals = (group?.opportunities || opportunities).map(opp => mapOpportunityToDeal(opp, customer));

    return (
      <PipelineKanban
        initialDeals={deals}
        initialStages={group?.stages || []}
        workspaceId={currentWorkspace?.id || ''}
        customers={customers}
        onDealMove={handleDealMove}
        onDealCreate={handleDealCreate}
        pipelineId={group?.id}
        pipelineName={group?.name}
        lockedCustomer={lockedCustomer}
      />
    );
  }

  // Multiple pipelines → show EntityList with expandable kanbans
  return (
    <MultiPipelineList
      pipelineGroups={pipelineGroups}
      customer={customer}
      customers={customers}
      workspaceId={currentWorkspace?.id || ''}
      lockedCustomer={lockedCustomer}
      onDealMove={handleDealMove}
      onDealCreate={handleDealCreate}
    />
  );
}

// Separate component to use hooks at top level
function MultiPipelineList({
  pipelineGroups,
  customer,
  customers,
  workspaceId,
  lockedCustomer,
  onDealMove,
  onDealCreate,
}: {
  pipelineGroups: PipelineRow[];
  customer: Customer;
  customers: PipelineCustomer[];
  workspaceId: string;
  lockedCustomer: { id: string; name: string };
  onDealMove: (dealId: string, fromStage: string, toStage: string) => Promise<void>;
  onDealCreate: (data: DealCreateData) => Promise<void>;
}) {
  const t = useTranslations();
  const [expandedPipelines, setExpandedPipelines] = useState<Set<string>>(new Set());

  const togglePipeline = useCallback((id: string) => {
    setExpandedPipelines(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'pipeline', header: t('sweep.weldcrm.dealsPipelineSection.pipeline'), width: 'flex-1 min-w-[200px]' },
    { id: 'deals', header: t('sweep.weldcrm.dealsSection.deals'), width: 'w-[80px]' },
    { id: 'value', header: t('sweep.weldcrm.dealDetailsModal.value'), width: 'w-[120px]' },
  ], [t]);

  const renderRow = useCallback((pipeline: PipelineRow) => {
    const isExpanded = expandedPipelines.has(pipeline.id);
    const deals = pipeline.opportunities.map(opp => mapOpportunityToDeal(opp, customer));

    return (
      <div key={pipeline.id}>
        <div
          onClick={() => togglePipeline(pipeline.id)}
          className={cn(
            "flex items-center gap-4 px-4 py-3 hover:bg-muted/50 cursor-pointer border-b border-border/70 group",
          )}
        >
          {/* Pipeline name */}
          <div className="flex-1 min-w-[200px] flex items-center gap-2">
            <ChevronRight className={cn(
              "h-4 w-4 text-muted-foreground transition-transform flex-shrink-0",
              isExpanded && "rotate-90"
            )} />
            <div className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]",
              getColorClass(pipeline.color)
            )}>
              <GitBranch className="h-3 w-3 text-white" />
            </div>
            <span className="text-sm font-medium text-foreground truncate">
              {pipeline.name}
            </span>
          </div>

          {/* Deal count */}
          <div className="w-[80px]">
            <span className="text-sm text-muted-foreground">
              {pipeline.dealCount}
            </span>
          </div>

          {/* Total value */}
          <div className="w-[120px]">
            <span className="text-sm text-muted-foreground">
              {formatCurrency(pipeline.totalValue)}
            </span>
          </div>

          {/* Spacer for actions column */}
          <div className="w-[40px]" />
        </div>

        {/* Expanded kanban */}
        {isExpanded && (
          <div className="border-b border-border/70">
            <PipelineKanban
              initialDeals={deals}
              initialStages={pipeline.stages}
              workspaceId={workspaceId}
              customers={customers}
              onDealMove={onDealMove}
              onDealCreate={onDealCreate}
              pipelineId={pipeline.id}
              pipelineName={pipeline.name}
              lockedCustomer={lockedCustomer}
              hideHeader
            />
          </div>
        )}
      </div>
    );
  }, [expandedPipelines, togglePipeline, customer, customers, workspaceId, lockedCustomer, onDealMove, onDealCreate]);

  return (
    <EntityList<PipelineRow>
      items={pipelineGroups}
      isLoading={false}
      error={null}
      headerColumns={headerColumns}
      filters={[]}
      maxFilters={0}
      renderRow={renderRow}
      searchPlaceholder={t('sweep.weldcrm.dealsPipelineSection.searchPipelines')}
      searchFields={['name']}
      emptyStateClassName="pb-24"
      emptyState={{
        icon: <GitBranch className="h-10 w-10 text-muted-foreground/50" />,
        title: t('sweep.weldcrm.dealsPipelineSection.noPipelinesFound'),
        description: t('sweep.weldcrm.dealsPipelineSection.noPipelinesForCustomer'),
      }}
      noResultsState={{
        title: t('sweep.weldcrm.dealsPipelineSection.noPipelinesFound'),
        description: t('sweep.weldcrm.dealsPipelineSection.noPipelinesMatchingSearch'),
      }}
    />
  );
}

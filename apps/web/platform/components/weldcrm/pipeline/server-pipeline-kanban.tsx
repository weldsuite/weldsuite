
import { PipelineKanban } from './pipeline-kanban';
import { useOpportunitiesByPipeline, useOpportunities, useUpdateOpportunityStage, useCreateOpportunity } from '@/hooks/queries/use-opportunities-queries';
import { usePipelineStages } from '@/hooks/queries/use-pipelines-queries';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { usePeople } from '@/components/objects/person/use-person-data';
import { DEFAULT_PIPELINE_SETTINGS } from '@/app/weldcrm/pipeline/pipeline-settings-types';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';
import { toast } from 'sonner';

interface ServerPipelineKanbanProps {
  pipelineId?: string;
  pipelineName?: string;
}

export function ServerPipelineKanban({ pipelineId, pipelineName }: ServerPipelineKanbanProps = {}) {
  const t = useTranslations();
  // Fetch opportunities - both hooks are always called to satisfy React rules of hooks
  // Only the relevant one is enabled based on whether pipelineId exists
  const pipelineOpportunities = useOpportunitiesByPipeline(pipelineId || '', !!pipelineId);
  const allOpportunities = useOpportunities(!pipelineId ? {} : undefined);
  const opportunitiesResult = pipelineId ? pipelineOpportunities.data : allOpportunities.data;
  const opportunitiesLoading = pipelineId ? pipelineOpportunities.isLoading : allOpportunities.isLoading;

  // Fetch pipeline stages
  const { data: stagesResult, isLoading: stagesLoading } = usePipelineStages(pipelineId);

  // Fetch companies and people for lookup
  const { data: companiesResult, isLoading: companiesLoading } = useCompanies();
  const { data: peopleResult, isLoading: peopleLoading } = usePeople();

  // Mutations
  const updateStageMutation = useUpdateOpportunityStage();
  const createOpportunityMutation = useCreateOpportunity();

  const isLoading = opportunitiesLoading || stagesLoading || companiesLoading || peopleLoading;

  if (isLoading) {
    return <PageLoader fullScreen={false} label={t('crm.pipeline.loading')} />;
  }

  const opportunities = pipelineId
    ? (opportunitiesResult?.data || [])
    : (opportunitiesResult?.data || []);

  const pipelineStages = stagesResult?.data || [];
  const customers = companiesResult?.data || [];
  const contacts = peopleResult?.data || [];

  // Create lookup maps for customer and contact names
  const customerMap = new Map<string, { id: string; name?: string; email?: string }>(
    customers.map((c: any) => [c.id, c])
  );
  const contactMap = new Map<string, { id: string; name?: string; email?: string }>(
    contacts.map((c: any) => [c.id, c])
  );

  // Map opportunities to the format expected by the kanban
  const deals = (Array.isArray(opportunities) ? opportunities : []).map((opp: any) => {
    // Look up customer data if customerId exists
    const customer = opp.customerId ? customerMap.get(opp.customerId) : null;
    const customerName = opp.customerName || customer?.name;

    // Look up contact data if primaryContactId exists
    const contactData = opp.primaryContactId ? contactMap.get(opp.primaryContactId) : null;

    return {
      id: opp.id,
      title: opp.name,
      value: opp.amount?.amount || opp.value || 0,
      stage: opp.stageId || opp.stage,
      company: (opp.customerId || customerName) ? {
        id: opp.customerId,
        name: customerName || t('sweep.weldcrm.serverPipelineKanban.unknownCompany')
      } : undefined,
      contact: opp.primaryContactId ? {
        id: opp.primaryContactId,
        name: contactData?.name || '',
        email: contactData?.email || ''
      } : undefined,
      probability: opp.probability || 0,
      expectedCloseDate: opp.closeDate,
      lastActivity: opp.lastActivityDate,
      tags: opp.tags || [],
      status: opp.status,
      notes: opp.description,
    };
  });

  async function handleDealMove(dealId: string, fromStage: string, toStage: string) {
    try {
      await updateStageMutation.mutateAsync({ id: dealId, stage: toStage });
    } catch (error) {
      console.error('Failed to update deal stage:', error);
      toast.error(t('sweep.weldcrm.serverPipelineKanban.failedToMoveDeal'));
    }
  }

  async function handleDealCreate(data: any) {
    try {
      await createOpportunityMutation.mutateAsync({
        ...data,
        pipeline: pipelineId,
      });
    } catch (error) {
      console.error('Failed to create deal:', error);
      toast.error(t('sweep.weldcrm.serverPipelineKanban.failedToCreateDeal'));
    }
  }

  return (
    <PipelineKanban
      initialDeals={deals}
      initialStages={pipelineStages}
      workspaceId=""
      customers={customers}
      contacts={contacts}
      onDealMove={handleDealMove}
      onDealCreate={handleDealCreate}
      pipelineId={pipelineId}
      pipelineName={pipelineName}
      initialSettings={DEFAULT_PIPELINE_SETTINGS}
    />
  );
}

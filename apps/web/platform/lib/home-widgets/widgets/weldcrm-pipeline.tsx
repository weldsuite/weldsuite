import { z } from 'zod';
import { Briefcase } from 'lucide-react';
import { NoSettingsForm } from '../common';
import { useOpportunities, type Opportunity } from '@/hooks/queries/use-opportunities-queries';
import { PipelineCard, type PipelineDealRow, type PipelineStageId } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldcrmPipelineSchema = z.object({});
export type WeldcrmPipelineSettings = z.infer<typeof weldcrmPipelineSchema>;

function mapStage(stage: string | undefined): PipelineStageId {
  const s = (stage ?? '').toLowerCase();
  if (s.includes('qualif')) return 'qualified';
  if (s.includes('propos')) return 'proposal';
  if (s.includes('negot') || s.includes('closing') || s.includes('won')) return 'negotiation';
  return 'lead';
}

function mapDeal(api: Opportunity): PipelineDealRow {
  return {
    stage: mapStage(api.stage),
    title: api.name,
    company: api.company?.name ?? api.customerName ?? '—',
    value: typeof api.value === 'number' ? api.value : Number(api.amount ?? 0),
    probability: typeof api.probability === 'number' ? api.probability : 0,
  };
}

function Render() {
  const res = useOpportunities();
  const apiRows = ((res.data as { data?: Opportunity[] } | undefined)?.data ?? []) as Opportunity[];
  // Only show open deals (anything not won/lost/closed).
  const open = apiRows.filter((o) => !['won', 'lost', 'closed', 'closed_won', 'closed_lost'].includes((o.status ?? '').toLowerCase()));
  const rows = open.map(mapDeal);
  return <PipelineCard rows={rows} isLoading={res.isLoading} />;
}

export const weldcrmPipelineWidget: HomeWidgetDefinition<WeldcrmPipelineSettings> = {
  id: 'weldcrm-pipeline',
  module: 'weldcrm',
  title: 'Pipeline',
  description: 'Active deals by stage',
  icon: Briefcase,
  schema: weldcrmPipelineSchema,
  defaultSettings: {},
  HomeRender: Render,
  SettingsForm: NoSettingsForm,
};

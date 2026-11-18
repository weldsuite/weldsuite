import { z } from 'zod';
import { Briefcase } from 'lucide-react';
import { NoSettingsForm } from '../common';
import { useMemo } from 'react';
import { useOpportunities, type Opportunity } from '@/hooks/queries/use-opportunities-queries';
import { usePipelineStages, type PipelineStage } from '@/hooks/queries/use-pipelines-queries';
import { PipelineCard, type PipelineDealRow, type PipelineStageId } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldcrmPipelineSchema = z.object({});
export type WeldcrmPipelineSettings = z.infer<typeof weldcrmPipelineSchema>;

const BUCKETS: PipelineStageId[] = ['lead', 'qualified', 'proposal', 'negotiation'];

/** The card's column for a stage name, or `undefined` when the name doesn't say. */
function bucketByName(name: string | undefined): PipelineStageId | undefined {
  const s = (name ?? '').toLowerCase();
  if (s.includes('qualif')) return 'qualified';
  if (s.includes('propos')) return 'proposal';
  if (s.includes('negot') || s.includes('closing') || s.includes('won')) return 'negotiation';
  if (s.includes('lead') || s.includes('prospect')) return 'lead';
  return undefined;
}

/**
 * The card's column for a deal. A deal in a pipeline stage carries the stage's
 * id in `stage` (TASK-1462: a Negotiation deal of a custom pipeline showed
 * under Lead), so the stage is resolved through `stageId`: by its name, else
 * by where it sits among its pipeline's open stages.
 */
export function pipelineBucket(api: Pick<Opportunity, 'stage' | 'stageId'>, stages: readonly PipelineStage[]): PipelineStageId {
  const stage = api.stageId ? stages.find((s) => s.id === api.stageId) : undefined;
  if (!stage) return bucketByName(api.stage) ?? 'lead';
  const named = bucketByName(stage.name);
  if (named) return named;
  const open = stages
    .filter((s) => s.pipeline === stage.pipeline && !s.isWon && !s.isLost)
    .sort((a, b) => a.position - b.position);
  const index = open.findIndex((s) => s.id === stage.id);
  if (index < 0 || open.length === 0) return 'negotiation';
  return BUCKETS[Math.min(BUCKETS.length - 1, Math.floor((index * BUCKETS.length) / open.length))]!;
}

function mapDeal(api: Opportunity, stages: readonly PipelineStage[]): PipelineDealRow {
  return {
    id: api.id,
    stage: pipelineBucket(api, stages),
    title: api.name,
    company: api.company?.name ?? api.customerName ?? '—',
    value: typeof api.value === 'number' ? api.value : Number(api.amount ?? 0),
    probability: typeof api.probability === 'number' ? api.probability : 0,
  };
}

function Render() {
  const res = useOpportunities();
  const stagesRes = usePipelineStages(undefined);
  const apiRows = ((res.data as { data?: Opportunity[] } | undefined)?.data ?? []) as Opportunity[];
  const stages = useMemo(() => stagesRes.data?.data ?? [], [stagesRes.data]);
  // Only show open deals (anything not won/lost/closed).
  const open = apiRows.filter((o) => !['won', 'lost', 'closed', 'closed_won', 'closed_lost'].includes((o.status ?? '').toLowerCase()));
  const rows = open.map((o) => mapDeal(o, stages));
  return <PipelineCard rows={rows} isLoading={res.isLoading || stagesRes.isLoading} />;
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

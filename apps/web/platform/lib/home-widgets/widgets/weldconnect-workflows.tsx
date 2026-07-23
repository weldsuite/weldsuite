import { z } from 'zod';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWorkflows } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import { WorkflowsCard, type WorkflowRow, type WorkflowStatus, type TriggerType } from '@/components/home/app-cards';
import type { Workflow } from '@/lib/api/domains/weldconnect';
import type { HomeWidgetDefinition } from '../types';

const weldconnectWorkflowsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldconnectWorkflowsSettings = z.infer<typeof weldconnectWorkflowsSchema>;

function mapStatus(s: Workflow['status']): WorkflowStatus {
  if (s === 'active') return 'active';
  if (s === 'paused') return 'paused';
  return 'draft';
}

function mapTrigger(triggers: Workflow['triggers']): TriggerType {
  const first = Array.isArray(triggers) ? triggers[0] : undefined;
  const type = (first?.type ?? first?.kind ?? '').toLowerCase();
  if (type.includes('schedule') || type.includes('cron')) return 'schedule';
  if (type.includes('manual')) return 'manual';
  return 'webhook';
}

function mapWorkflow(api: Workflow): WorkflowRow {
  const executions = api.executionCount ?? 0;
  const success = api.successCount ?? 0;
  const successRate = executions > 0 ? Math.round((success / executions) * 100) : 0;
  return {
    name: api.name,
    description: api.description ?? '',
    trigger: mapTrigger(api.triggers),
    steps: Array.isArray(api.steps) ? api.steps.length : 0,
    executions,
    successRate,
    status: mapStatus(api.status),
  };
}

function Render({ settings }: { settings: WeldconnectWorkflowsSettings }) {
  const res = useWorkflows({ pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: Workflow[] } | undefined)?.data ?? []) as Workflow[];
  const rows = apiRows.map(mapWorkflow).slice(0, settings.maxCount);
  return <WorkflowsCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldconnectWorkflowsSettings; onChange: (next: WeldconnectWorkflowsSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div>
      <Label className="mb-2 block">{f.maxRows}</Label>
      <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export const weldconnectWorkflowsWidget: HomeWidgetDefinition<WeldconnectWorkflowsSettings> = {
  id: 'weldconnect-workflows',
  module: 'weldconnect',
  title: 'Workflows',
  description: 'Configured workflows',
  icon: WorkflowIcon,
  schema: weldconnectWorkflowsSchema,
  defaultSettings: weldconnectWorkflowsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

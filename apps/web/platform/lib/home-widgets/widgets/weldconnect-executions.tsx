import { z } from 'zod';
import { ListTodo } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useExecutions } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ConnectCard, type ExecutionRow, type ExecStatus } from '@/components/home/app-cards';
import type { WorkflowExecution } from '@/lib/api/domains/weldconnect';
import type { HomeWidgetDefinition } from '../types';

const weldconnectExecutionsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldconnectExecutionsSettings = z.infer<typeof weldconnectExecutionsSchema>;

function relativeAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  const diffDays = Math.floor(diffMin / 1440);
  if (diffDays === 1) return 'Yest';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function mapStatus(s: WorkflowExecution['status']): ExecStatus {
  return s;
}

function mapExec(api: WorkflowExecution): ExecutionRow {
  return {
    id: api.id,
    workflowName: api.workflowName ?? api.workflowId,
    status: mapStatus(api.status),
    completed: api.currentStepIndex ?? 0,
    total: api.totalSteps ?? 0,
    duration: formatDuration(api.duration),
    startedAgo: relativeAgo(api.startedAt ?? api.createdAt),
  };
}

function Render({ settings }: { settings: WeldconnectExecutionsSettings }) {
  const res = useExecutions({ limit: settings.maxCount });
  const apiRows = ((res.data as { data?: WorkflowExecution[] } | undefined)?.data ?? []) as WorkflowExecution[];
  const rows = apiRows.map(mapExec).slice(0, settings.maxCount);
  return <ConnectCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldconnectExecutionsSettings; onChange: (next: WeldconnectExecutionsSettings) => void }) {
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

export const weldconnectExecutionsWidget: HomeWidgetDefinition<WeldconnectExecutionsSettings> = {
  id: 'weldconnect-executions',
  module: 'weldconnect',
  title: 'Recent executions',
  description: 'Workflow run history',
  icon: ListTodo,
  schema: weldconnectExecutionsSchema,
  defaultSettings: weldconnectExecutionsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

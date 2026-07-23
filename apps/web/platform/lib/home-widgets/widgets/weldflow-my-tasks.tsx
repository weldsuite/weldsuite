import { z } from 'zod';
import { ListChecks } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTasks } from '@/hooks/queries/use-task-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useObjectPanel } from '@/components/object-panel';
import { FlowCard, type FlowRow, type FlowStatus, type FlowPriority } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const statusValues = ['all', 'todo', 'in_progress', 'review', 'done'] as const;
const priorityValues = ['all', 'low', 'medium', 'high'] as const;

const weldflowMyTasksSchema = z.object({
  assigneeMe: z.boolean().default(true),
  status: z.enum(statusValues).default('all'),
  priority: z.enum(priorityValues).default('all'),
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldflowMyTasksSettings = z.infer<typeof weldflowMyTasksSchema>;

interface ApiTask {
  id: string;
  title?: string;
  status?: string;
  priority?: string;
  projectName?: string;
  project?: { name?: string };
  assigneeId?: string;
}

function mapStatus(s: string | undefined): FlowStatus {
  if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'in_progress';
  if (s === 'review') return 'review';
  if (s === 'done' || s === 'completed') return 'done';
  return 'todo';
}

function mapPriority(p: string | undefined): FlowPriority {
  if (p === 'high' || p === 'urgent' || p === 'critical') return 'high';
  if (p === 'medium' || p === 'normal') return 'medium';
  return 'low';
}

function mapTask(api: ApiTask): FlowRow {
  return {
    id: api.id,
    title: api.title ?? '—',
    project: api.projectName ?? api.project?.name ?? '—',
    status: mapStatus(api.status),
    priority: mapPriority(api.priority),
  };
}

function Render({ settings }: { settings: WeldflowMyTasksSettings }) {
  const { user } = useUser();
  const { open: openObjectPanel } = useObjectPanel();
  const tasksRes = useTasks({
    assigneeId: settings.assigneeMe ? user?.id : undefined,
    status: settings.status === 'all' ? undefined : settings.status,
    priority: settings.priority === 'all' ? undefined : settings.priority,
    pageSize: settings.maxCount,
  });
  const apiRows = ((tasksRes.data as { data?: ApiTask[] } | undefined)?.data ?? []) as ApiTask[];
  const rows = apiRows.map(mapTask).slice(0, settings.maxCount);

  return (
    <FlowCard
      rows={rows}
      isLoading={tasksRes.isLoading}
      onRowClick={(row) => {
        if (row.id) openObjectPanel({ type: 'task', id: row.id });
      }}
    />
  );
}

function SettingsForm({ value, onChange }: { value: WeldflowMyTasksSettings; onChange: (next: WeldflowMyTasksSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>{f.assigneeMe}</span>
        <Switch checked={value.assigneeMe} onCheckedChange={(v) => onChange({ ...value, assigneeMe: v })} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-2 block">{f.status}</Label>
          <Select value={value.status} onValueChange={(v) => onChange({ ...value, status: v as WeldflowMyTasksSettings['status'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusValues.map((s) => <SelectItem key={s} value={s}>{s.replace('_', ' ')}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-2 block">{f.priority}</Label>
          <Select value={value.priority} onValueChange={(v) => onChange({ ...value, priority: v as WeldflowMyTasksSettings['priority'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {priorityValues.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="mb-2 block">{f.maxRows}</Label>
        <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export const weldflowMyTasksWidget: HomeWidgetDefinition<WeldflowMyTasksSettings> = {
  id: 'weldflow-my-tasks',
  module: 'weldflow',
  title: 'My tasks',
  description: 'WeldFlow tasks',
  icon: ListChecks,
  schema: weldflowMyTasksSchema,
  defaultSettings: weldflowMyTasksSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

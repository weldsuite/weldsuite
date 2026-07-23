import { z } from 'zod';
import { Briefcase } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useActivities } from '@/hooks/queries/use-activities-queries';
import { useI18n } from '@/lib/i18n/provider';
import { CrmCard, type CrmTaskRow, type CrmTaskStatus, type CrmTaskPriority } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldcrmMyTasksSchema = z.object({
  assigneeMe: z.boolean().default(true),
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldcrmMyTasksSettings = z.infer<typeof weldcrmMyTasksSchema>;

interface ApiActivity {
  id: string;
  type?: string;
  subject?: string;
  title?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  customerName?: string;
  company?: { name?: string };
  customer?: { name?: string };
}

function mapStatus(s: string | undefined): CrmTaskStatus {
  if (s === 'todo' || s === 'pending') return 'todo';
  if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'in_progress';
  if (s === 'in_review' || s === 'review') return 'in_review';
  if (s === 'testing') return 'testing';
  if (s === 'done' || s === 'completed') return 'done';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'backlog';
}

function mapPriority(p: string | undefined): CrmTaskPriority | null {
  if (p === 'high' || p === 'urgent') return 'high';
  if (p === 'medium' || p === 'normal') return 'medium';
  if (p === 'low') return 'low';
  return null;
}

function formatDue(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapActivity(api: ApiActivity): CrmTaskRow {
  return {
    title: api.subject ?? api.title ?? '—',
    company: api.customerName ?? api.company?.name ?? api.customer?.name ?? null,
    status: mapStatus(api.status),
    priority: mapPriority(api.priority),
    due: formatDue(api.dueDate),
  };
}

function Render({ settings }: { settings: WeldcrmMyTasksSettings }) {
  const { user } = useUser();
  const res = useActivities({
    type: 'task',
    assignedToId: settings.assigneeMe ? user?.id : undefined,
    limit: settings.maxCount,
  });
  const apiRows = ((res.data as { data?: ApiActivity[] } | undefined)?.data ?? []) as ApiActivity[];
  const rows = apiRows.map(mapActivity).slice(0, settings.maxCount);
  return <CrmCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldcrmMyTasksSettings; onChange: (next: WeldcrmMyTasksSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>{f.assigneeMe}</span>
        <Switch checked={value.assigneeMe} onCheckedChange={(v) => onChange({ ...value, assigneeMe: v })} />
      </label>
      <div>
        <Label className="mb-2 block">{f.maxRows}</Label>
        <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

export const weldcrmMyTasksWidget: HomeWidgetDefinition<WeldcrmMyTasksSettings> = {
  id: 'weldcrm-my-tasks',
  module: 'weldcrm',
  title: 'CRM tasks',
  description: 'CRM follow-ups',
  icon: Briefcase,
  schema: weldcrmMyTasksSchema,
  defaultSettings: weldcrmMyTasksSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

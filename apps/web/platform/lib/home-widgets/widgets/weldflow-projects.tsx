import { z } from 'zod';
import { FolderKanban } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTaskProjects } from '@/hooks/queries/use-task-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useObjectPanel } from '@/components/object-panel';
import {
  ProjectsCard,
  type ProjectRow,
  type ProjectStatus,
  type ProjectPriority,
} from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const statusValues = ['all', 'on-track', 'at-risk', 'off-track', 'on-hold', 'completed'] as const;

const weldflowProjectsSchema = z.object({
  status: z.enum(statusValues).default('all'),
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldflowProjectsSettings = z.infer<typeof weldflowProjectsSchema>;

interface ApiProject {
  id: string;
  name?: string;
  color?: string;
  status?: string;
  priority?: string;
  progress?: number;
  dueDate?: string | null;
  endDate?: string | null;
}

const PROJECT_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-emerald-500', 'bg-cyan-500', 'bg-amber-500', 'bg-rose-500'];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

function mapStatus(s: string | undefined): ProjectStatus {
  if (s === 'on_track' || s === 'on-track' || s === 'active' || s === 'in_progress') return 'on-track';
  if (s === 'at_risk' || s === 'at-risk') return 'at-risk';
  if (s === 'off_track' || s === 'off-track' || s === 'blocked') return 'off-track';
  if (s === 'on_hold' || s === 'on-hold' || s === 'paused') return 'on-hold';
  if (s === 'completed' || s === 'done' || s === 'closed') return 'completed';
  return 'on-track';
}

function mapPriority(p: string | undefined): ProjectPriority {
  if (p === 'critical' || p === 'urgent') return 'critical';
  if (p === 'high') return 'high';
  if (p === 'medium' || p === 'normal') return 'medium';
  return 'low';
}

function formatDue(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapProject(api: ApiProject): ProjectRow {
  return {
    id: api.id,
    name: api.name ?? '—',
    color: colorFor(api.id),
    status: mapStatus(api.status),
    priority: mapPriority(api.priority),
    progress: typeof api.progress === 'number' ? Math.min(Math.max(api.progress, 0), 100) : 0,
    due: formatDue(api.dueDate ?? api.endDate),
  };
}

function Render({ settings }: { settings: WeldflowProjectsSettings }) {
  const projectsRes = useTaskProjects({ pageSize: settings.maxCount });
  const { open: openObjectPanel } = useObjectPanel();
  const apiRows = ((projectsRes.data as { data?: ApiProject[] } | undefined)?.data ?? []) as ApiProject[];
  const filtered = settings.status === 'all'
    ? apiRows
    : apiRows.filter((p) => mapStatus(p.status) === settings.status);
  const rows = filtered.map(mapProject).slice(0, settings.maxCount);

  return (
    <ProjectsCard
      rows={rows}
      isLoading={projectsRes.isLoading}
      onRowClick={(row) => {
        if (row.id) openObjectPanel({ type: 'project', id: row.id });
      }}
    />
  );
}

function SettingsForm({ value, onChange }: { value: WeldflowProjectsSettings; onChange: (next: WeldflowProjectsSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div className="space-y-4">
      <div>
        <Label className="mb-2 block">{f.status}</Label>
        <Select value={value.status} onValueChange={(v) => onChange({ ...value, status: v as WeldflowProjectsSettings['status'] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {statusValues.map((s) => <SelectItem key={s} value={s}>{s.replace('_', ' ')}</SelectItem>)}
          </SelectContent>
        </Select>
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

export const weldflowProjectsWidget: HomeWidgetDefinition<WeldflowProjectsSettings> = {
  id: 'weldflow-projects',
  module: 'weldflow',
  title: 'Projects',
  description: 'WeldFlow projects',
  icon: FolderKanban,
  schema: weldflowProjectsSchema,
  defaultSettings: weldflowProjectsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

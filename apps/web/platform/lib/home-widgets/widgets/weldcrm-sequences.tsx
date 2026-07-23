import { z } from 'zod';
import { Workflow } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useSequences } from '@/hooks/queries/use-sequences-queries';
import { useI18n } from '@/lib/i18n/provider';
import { SequencesCard, type SequenceRow, type SequenceStatus } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldcrmSequencesSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldcrmSequencesSettings = z.infer<typeof weldcrmSequencesSchema>;

interface ApiSequence {
  id: string;
  name: string;
  description?: string;
  status?: string;
  enrolledCount?: number;
  activeCount?: number;
  lastRunAt?: string | null;
}

function mapStatus(s: string | undefined): SequenceStatus {
  if (s === 'active') return 'active';
  if (s === 'paused') return 'paused';
  return 'draft';
}

function formatLastRun(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapSequence(api: ApiSequence): SequenceRow {
  return {
    name: api.name,
    description: api.description ?? '',
    status: mapStatus(api.status),
    enrolled: api.enrolledCount ?? 0,
    active: api.activeCount ?? 0,
    lastRun: formatLastRun(api.lastRunAt),
  };
}

function Render({ settings }: { settings: WeldcrmSequencesSettings }) {
  const res = useSequences({ pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: ApiSequence[] } | undefined)?.data ?? []) as ApiSequence[];
  const rows = apiRows.map(mapSequence).slice(0, settings.maxCount);
  return <SequencesCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldcrmSequencesSettings; onChange: (next: WeldcrmSequencesSettings) => void }) {
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

export const weldcrmSequencesWidget: HomeWidgetDefinition<WeldcrmSequencesSettings> = {
  id: 'weldcrm-sequences',
  module: 'weldcrm',
  title: 'Sequences',
  description: 'Outbound sequences',
  icon: Workflow,
  schema: weldcrmSequencesSchema,
  defaultSettings: weldcrmSequencesSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

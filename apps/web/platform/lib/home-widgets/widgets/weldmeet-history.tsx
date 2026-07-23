import { z } from 'zod';
import { Video } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useMeetings } from '@/hooks/queries/use-weldmeet-queries';
import { useI18n } from '@/lib/i18n/provider';
import { MeetHistoryCard, type MeetingHistoryRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldmeetHistorySchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldmeetHistorySettings = z.infer<typeof weldmeetHistorySchema>;

interface ApiMeeting {
  id: string;
  title?: string;
  type?: string;
  scheduledStart?: string;
  actualStart?: string;
  participants?: Array<{ initials?: string; name?: string }>;
  attendeeCount?: number;
  durationMinutes?: number;
  hasRecording?: boolean;
  recordingUrl?: string | null;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 1) return 'Yest';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(min: number | undefined): string {
  if (typeof min !== 'number' || min <= 0) return '—';
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

function mapMeeting(api: ApiMeeting): MeetingHistoryRow {
  const participants = (api.participants ?? []).slice(0, 3).map((p) => (p.initials ?? p.name?.charAt(0) ?? '?').toUpperCase());
  return {
    title: api.title ?? '—',
    type: api.type === 'audio' ? 'audio' : 'video',
    date: formatDate(api.actualStart ?? api.scheduledStart),
    participants,
    totalParticipants: api.attendeeCount ?? participants.length,
    duration: formatDuration(api.durationMinutes),
    recorded: !!(api.hasRecording || api.recordingUrl),
  };
}

function Render({ settings }: { settings: WeldmeetHistorySettings }) {
  const res = useMeetings({ status: 'completed', pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: ApiMeeting[] } | undefined)?.data ?? []) as ApiMeeting[];
  const rows = apiRows.map(mapMeeting).slice(0, settings.maxCount);
  return <MeetHistoryCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldmeetHistorySettings; onChange: (next: WeldmeetHistorySettings) => void }) {
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

export const weldmeetHistoryWidget: HomeWidgetDefinition<WeldmeetHistorySettings> = {
  id: 'weldmeet-history',
  module: 'weldmeet',
  title: 'Past meetings',
  description: 'Meeting history',
  icon: Video,
  schema: weldmeetHistorySchema,
  defaultSettings: weldmeetHistorySchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

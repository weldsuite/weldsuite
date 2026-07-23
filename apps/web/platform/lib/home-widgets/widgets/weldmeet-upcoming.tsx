import { z } from 'zod';
import { Video } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useMeetings } from '@/hooks/queries/use-weldmeet-queries';
import { useI18n } from '@/lib/i18n/provider';
import { MeetCard, type MeetingRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldmeetUpcomingSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldmeetUpcomingSettings = z.infer<typeof weldmeetUpcomingSchema>;

interface ApiMeeting {
  id: string;
  title?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  durationMinutes?: number;
  attendeeCount?: number;
  status?: string;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === -1) return `Tomorrow ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(min: number | undefined, start: string | undefined, end: string | undefined): string {
  if (typeof min === 'number' && min > 0) return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isNaN(ms) && ms > 0) {
      const mins = Math.round(ms / 60_000);
      return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    }
  }
  return '—';
}

function mapMeeting(api: ApiMeeting): MeetingRow {
  return {
    time: formatTime(api.scheduledStart),
    title: api.title ?? '—',
    duration: formatDuration(api.durationMinutes, api.scheduledStart, api.scheduledEnd),
    attendees: api.attendeeCount ?? 0,
    status: api.status ?? 'upcoming',
  };
}

function Render({ settings }: { settings: WeldmeetUpcomingSettings }) {
  const res = useMeetings({ status: 'scheduled', pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: ApiMeeting[] } | undefined)?.data ?? []) as ApiMeeting[];
  const rows = apiRows.map(mapMeeting).slice(0, settings.maxCount);
  return <MeetCard rows={rows} isLoading={res.isLoading} title="WeldMeet — Upcoming" />;
}

function SettingsForm({ value, onChange }: { value: WeldmeetUpcomingSettings; onChange: (next: WeldmeetUpcomingSettings) => void }) {
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

export const weldmeetUpcomingWidget: HomeWidgetDefinition<WeldmeetUpcomingSettings> = {
  id: 'weldmeet-upcoming',
  module: 'weldmeet',
  title: 'Upcoming meetings',
  description: 'Scheduled meetings',
  icon: Video,
  schema: weldmeetUpcomingSchema,
  defaultSettings: weldmeetUpcomingSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

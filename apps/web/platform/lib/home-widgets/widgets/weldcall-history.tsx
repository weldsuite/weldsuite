import { z } from 'zod';
import { Phone } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useVoipCalls } from '@/hooks/queries/use-voip-calls-queries';
import { useI18n } from '@/lib/i18n/provider';
import { CallCard, type CallRow, type CallStatus } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldcallHistorySchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldcallHistorySettings = z.infer<typeof weldcallHistorySchema>;

interface ApiCall {
  id: string;
  direction?: string;
  fromNumber?: string;
  toNumber?: string;
  durationSeconds?: number;
  hasRecording?: boolean;
  recordingUrl?: string | null;
  status?: string;
  startedAt?: string;
  createdAt?: string;
}

function mapDirection(d: string | undefined): 'inbound' | 'outbound' {
  return d === 'outbound' ? 'outbound' : 'inbound';
}

function mapStatus(s: string | undefined): CallStatus {
  switch (s) {
    case 'completed':
    case 'failed':
    case 'busy':
    case 'no_answer':
    case 'canceled':
    case 'answered':
    case 'ringing':
      return s;
    default:
      return 'completed';
  }
}

function formatDuration(sec: number | undefined): string {
  if (typeof sec !== 'number' || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function mapCall(api: ApiCall): CallRow {
  return {
    direction: mapDirection(api.direction),
    from: api.fromNumber ?? '—',
    to: api.toNumber ?? '—',
    duration: formatDuration(api.durationSeconds),
    isRecorded: !!(api.hasRecording || api.recordingUrl),
    status: mapStatus(api.status),
    date: formatDate(api.startedAt ?? api.createdAt),
  };
}

function Render({ settings }: { settings: WeldcallHistorySettings }) {
  const res = useVoipCalls({ pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: ApiCall[] } | undefined)?.data ?? []) as ApiCall[];
  const rows = apiRows.map(mapCall).slice(0, settings.maxCount);
  return <CallCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldcallHistorySettings; onChange: (next: WeldcallHistorySettings) => void }) {
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

export const weldcallHistoryWidget: HomeWidgetDefinition<WeldcallHistorySettings> = {
  id: 'weldcall-history',
  module: 'weldcall',
  title: 'Call history',
  description: 'Recent inbound + outbound calls',
  icon: Phone,
  schema: weldcallHistorySchema,
  defaultSettings: weldcallHistorySchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

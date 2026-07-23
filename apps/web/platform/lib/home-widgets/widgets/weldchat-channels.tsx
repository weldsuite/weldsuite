import { z } from 'zod';
import { Hash } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useChannels } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ChatChannelsCard, type ChannelRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldchatChannelsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldchatChannelsSettings = z.infer<typeof weldchatChannelsSchema>;

interface ApiChannel {
  id: string;
  name?: string;
  lastMessageSender?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string | null;
  unreadCount?: number;
  memberCount?: number;
}

function relativeWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  const diffDays = Math.floor(diffMin / 1440);
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapChannel(api: ApiChannel): ChannelRow {
  return {
    name: api.name ?? '—',
    sender: api.lastMessageSender ?? '',
    message: api.lastMessagePreview ?? '',
    when: relativeWhen(api.lastMessageAt),
    unread: api.unreadCount ?? 0,
    members: api.memberCount ?? 0,
  };
}

function Render({ settings }: { settings: WeldchatChannelsSettings }) {
  const res = useChannels();
  const apiRows = ((res.data as { data?: ApiChannel[] } | undefined)?.data ?? []) as ApiChannel[];
  const rows = apiRows.map(mapChannel).slice(0, settings.maxCount);
  return <ChatChannelsCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldchatChannelsSettings; onChange: (next: WeldchatChannelsSettings) => void }) {
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

export const weldchatChannelsWidget: HomeWidgetDefinition<WeldchatChannelsSettings> = {
  id: 'weldchat-channels',
  module: 'weldchat',
  title: 'Channels',
  description: 'WeldChat channels',
  icon: Hash,
  schema: weldchatChannelsSchema,
  defaultSettings: weldchatChannelsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

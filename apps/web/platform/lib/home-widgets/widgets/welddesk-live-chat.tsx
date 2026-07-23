import { z } from 'zod';
import { MessageSquare } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTickets, type ApiTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskLiveChatCard, type DeskLiveChatRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddeskLiveChatSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskLiveChatSettings = z.infer<typeof welddeskLiveChatSchema>;

function relativeWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  const diffDays = Math.floor(diffMin / 1440);
  if (diffDays === 1) return 'Yest';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function mapToChatRow(api: ApiTicket): DeskLiveChatRow {
  const visitor = api.customerName ?? api.customerEmail ?? 'Anonymous visitor';
  return {
    visitor,
    initials: visitor.charAt(0).toUpperCase(),
    url: '',
    preview: api.subject ?? api.description ?? '',
    when: relativeWhen(api.createdAt),
    online: api.status === 'open',
    unread: api.status === 'open' ? 1 : 0,
  };
}

function Render({ settings }: { settings: WelddeskLiveChatSettings }) {
  const ticketsRes = useTickets({ pageSize: settings.maxCount * 3 });
  const apiRows = ((ticketsRes.data as { data?: ApiTicket[] } | undefined)?.data ?? []) as ApiTicket[];
  const chats = apiRows.filter((t) => (t.source ?? t.channel) === 'chat' || (t.source ?? t.channel) === 'widget');
  const rows = chats.map(mapToChatRow).slice(0, settings.maxCount);
  return <DeskLiveChatCard rows={rows} isLoading={ticketsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskLiveChatSettings; onChange: (next: WelddeskLiveChatSettings) => void }) {
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

export const welddeskLiveChatWidget: HomeWidgetDefinition<WelddeskLiveChatSettings> = {
  id: 'welddesk-live-chat',
  module: 'welddesk',
  title: 'Live chat',
  description: 'Active widget conversations',
  icon: MessageSquare,
  schema: welddeskLiveChatSchema,
  defaultSettings: welddeskLiveChatSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

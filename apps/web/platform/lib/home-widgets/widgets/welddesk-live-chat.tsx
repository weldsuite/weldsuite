import { z } from 'zod';
import { MessageSquare } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useDeskConversations } from '@/hooks/queries/use-desk-queries';
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

function Render({ settings }: { settings: WelddeskLiveChatSettings }) {
  const { data, isLoading } = useDeskConversations({ state: 'open' }, 'newest');
  const conversations = data?.pages.flatMap((page) => page.data) ?? [];
  const rows: DeskLiveChatRow[] = conversations.slice(0, settings.maxCount).map((conversation) => {
    const visitor = conversation.name ?? conversation.email ?? 'Anonymous visitor';
    return {
      visitor,
      initials: visitor.charAt(0).toUpperCase(),
      url: '',
      preview: conversation.lastMessagePreview ?? conversation.title ?? '',
      when: relativeWhen(conversation.lastMessageAt ?? conversation.updatedAt),
      online: conversation.state === 'open',
      unread: conversation.state === 'open' ? 1 : 0,
      href: `/welddesk/inbox/${conversation.id}`,
    };
  });
  return <DeskLiveChatCard rows={rows} isLoading={isLoading} />;
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
  title: 'Inbox',
  description: 'Open visitor conversations',
  icon: MessageSquare,
  schema: welddeskLiveChatSchema,
  defaultSettings: welddeskLiveChatSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

import { z } from 'zod';
import { Bot } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTickets, type ApiTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskAiActiveCard, type DeskAiActiveRow, type AiAgentState } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddeskAiActiveSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskAiActiveSettings = z.infer<typeof welddeskAiActiveSchema>;

function relativeWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 60) return `${Math.max(1, diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  return 'Yest';
}

function mapState(s: string | undefined): AiAgentState {
  if (s === 'pending') return 'awaiting-customer';
  if (s === 'on-hold' || s === 'on_hold') return 'handing-off';
  return 'collecting-info';
}

function mapRow(api: ApiTicket): DeskAiActiveRow {
  const customer = api.customerName ?? api.customerEmail ?? '—';
  return {
    customer,
    initials: customer.charAt(0).toUpperCase(),
    intent: api.subject,
    state: mapState(api.status),
    turns: 0,
    started: relativeWhen(api.createdAt),
  };
}

function Render({ settings }: { settings: WelddeskAiActiveSettings }) {
  // Approximation: "active AI" = open tickets handled by an AI assignee/tag. The current
  // backend doesn't expose a dedicated aiState filter, so we surface open tickets and
  // let real wiring (a dedicated /helpdesk/ai-conversations route) replace this later.
  const ticketsRes = useTickets({ status: 'open', pageSize: settings.maxCount });
  const apiRows = ((ticketsRes.data as { data?: ApiTicket[] } | undefined)?.data ?? []) as ApiTicket[];
  const rows = apiRows.map(mapRow).slice(0, settings.maxCount);
  return <DeskAiActiveCard rows={rows} isLoading={ticketsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskAiActiveSettings; onChange: (next: WelddeskAiActiveSettings) => void }) {
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

export const welddeskAiActiveWidget: HomeWidgetDefinition<WelddeskAiActiveSettings> = {
  id: 'welddesk-ai-active',
  module: 'welddesk',
  title: 'AI agent — active',
  description: 'Conversations in progress',
  icon: Bot,
  schema: welddeskAiActiveSchema,
  defaultSettings: welddeskAiActiveSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

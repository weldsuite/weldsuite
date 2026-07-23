import { z } from 'zod';
import { Bot } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTickets, type ApiTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskAiResolvedCard, type DeskAiResolvedRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddeskAiResolvedSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskAiResolvedSettings = z.infer<typeof welddeskAiResolvedSchema>;

function relativeWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 60) return `${Math.max(1, diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  return 'Yest';
}

function mapRow(api: ApiTicket): DeskAiResolvedRow {
  const customer = api.customerName ?? api.customerEmail ?? '—';
  return {
    customer,
    initials: customer.charAt(0).toUpperCase(),
    intent: api.subject,
    resolution: 'kb-article',
    csat: null,
    resolvedIn: '—',
    when: relativeWhen(api.updatedAt),
  };
}

function Render({ settings }: { settings: WelddeskAiResolvedSettings }) {
  // Approximation: resolved tickets, regardless of agent identity. A dedicated
  // /helpdesk/ai-conversations endpoint can later distinguish AI vs human resolution.
  const ticketsRes = useTickets({ status: 'resolved', pageSize: settings.maxCount });
  const apiRows = ((ticketsRes.data as { data?: ApiTicket[] } | undefined)?.data ?? []) as ApiTicket[];
  const rows = apiRows.map(mapRow).slice(0, settings.maxCount);
  return <DeskAiResolvedCard rows={rows} isLoading={ticketsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskAiResolvedSettings; onChange: (next: WelddeskAiResolvedSettings) => void }) {
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

export const welddeskAiResolvedWidget: HomeWidgetDefinition<WelddeskAiResolvedSettings> = {
  id: 'welddesk-ai-resolved',
  module: 'welddesk',
  title: 'AI agent — resolved',
  description: 'Recently resolved conversations',
  icon: Bot,
  schema: welddeskAiResolvedSchema,
  defaultSettings: welddeskAiResolvedSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

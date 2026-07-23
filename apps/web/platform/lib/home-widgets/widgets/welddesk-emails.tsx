import { z } from 'zod';
import { Mail } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTickets, type ApiTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskEmailsCard, type DeskEmailRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddeskEmailsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskEmailsSettings = z.infer<typeof welddeskEmailsSchema>;

function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapToEmailRow(api: ApiTicket): DeskEmailRow {
  const from = api.customerName ?? api.customerEmail ?? '—';
  return {
    from,
    initials: from.charAt(0).toUpperCase(),
    subject: api.subject,
    preview: api.description ?? '',
    when: formatWhen(api.createdAt),
    priority: api.priority || 'normal',
    unread: api.status === 'open',
  };
}

function Render({ settings }: { settings: WelddeskEmailsSettings }) {
  // Filter to email-source tickets. The API uses `source` or `channel` interchangeably;
  // we filter client-side to be defensive against either name.
  const ticketsRes = useTickets({ pageSize: settings.maxCount * 3 });
  const apiRows = ((ticketsRes.data as { data?: ApiTicket[] } | undefined)?.data ?? []) as ApiTicket[];
  const emailTickets = apiRows.filter((t) => (t.source ?? t.channel) === 'email');
  const rows = emailTickets.map(mapToEmailRow).slice(0, settings.maxCount);
  return <DeskEmailsCard rows={rows} isLoading={ticketsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskEmailsSettings; onChange: (next: WelddeskEmailsSettings) => void }) {
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

export const welddeskEmailsWidget: HomeWidgetDefinition<WelddeskEmailsSettings> = {
  id: 'welddesk-emails',
  module: 'welddesk',
  title: 'Helpdesk emails',
  description: 'Recent helpdesk emails',
  icon: Mail,
  schema: welddeskEmailsSchema,
  defaultSettings: welddeskEmailsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

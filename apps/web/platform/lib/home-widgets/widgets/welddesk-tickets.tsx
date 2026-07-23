import { z } from 'zod';
import { LifeBuoy } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTickets, type ApiTicket } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskCard, type DeskTicketRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const priorityValues = ['all', 'low', 'normal', 'high', 'urgent'] as const;
const statusValues = ['all', 'open', 'pending', 'on-hold', 'resolved', 'closed'] as const;

const welddeskTicketsSchema = z.object({
  assigneeMe: z.boolean().default(false),
  priority: z.enum(priorityValues).default('all'),
  status: z.enum(statusValues).default('open'),
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskTicketsSettings = z.infer<typeof welddeskTicketsSchema>;

function mapPriority(p: string | undefined): string {
  if (p === 'urgent' || p === 'high' || p === 'normal' || p === 'low') return p;
  if (p === 'medium') return 'normal';
  return 'normal';
}

function mapTicket(api: ApiTicket): DeskTicketRow {
  const created = api.createdAt ? new Date(api.createdAt) : new Date();
  return {
    id: api.id,
    from: api.customerName ?? api.customerEmail ?? '—',
    email: api.customerEmail,
    subject: api.subject,
    preview: api.description ?? '',
    date: Number.isNaN(created.getTime()) ? new Date() : created,
    priority: mapPriority(api.priority),
    unread: api.status === 'open',
  };
}

function Render({ settings }: { settings: WelddeskTicketsSettings }) {
  const { user } = useUser();
  const ticketsRes = useTickets({
    assigneeId: settings.assigneeMe ? user?.id : undefined,
    priority: settings.priority === 'all' ? undefined : settings.priority,
    status: settings.status === 'all' ? undefined : settings.status,
    pageSize: settings.maxCount,
  });
  const apiRows = ((ticketsRes.data as { data?: ApiTicket[] } | undefined)?.data ?? []) as ApiTicket[];
  const rows = apiRows.map(mapTicket).slice(0, settings.maxCount);
  return <DeskCard rows={rows} isLoading={ticketsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskTicketsSettings; onChange: (next: WelddeskTicketsSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>{f.assigneeMe}</span>
        <Switch checked={value.assigneeMe} onCheckedChange={(v) => onChange({ ...value, assigneeMe: v })} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-2 block">{f.status}</Label>
          <Select value={value.status} onValueChange={(v) => onChange({ ...value, status: v as WelddeskTicketsSettings['status'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{statusValues.map((s) => <SelectItem key={s} value={s}>{s.replace('-', ' ')}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-2 block">{f.priority}</Label>
          <Select value={value.priority} onValueChange={(v) => onChange({ ...value, priority: v as WelddeskTicketsSettings['priority'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{priorityValues.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="mb-2 block">{f.maxRows}</Label>
        <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

export const welddeskTicketsWidget: HomeWidgetDefinition<WelddeskTicketsSettings> = {
  id: 'welddesk-tickets',
  module: 'welddesk',
  title: 'Open tickets',
  description: 'WeldDesk tickets',
  icon: LifeBuoy,
  schema: welddeskTicketsSchema,
  defaultSettings: welddeskTicketsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

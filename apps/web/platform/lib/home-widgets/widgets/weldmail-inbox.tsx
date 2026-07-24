import { z } from 'zod';
import { Mail } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useMailAccounts, useMailMessages } from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { MailCard, type MailRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const folderValues = ['inbox', 'sent', 'drafts', 'archive', 'all'] as const;
const sortValues = ['newest', 'oldest', 'unread'] as const;

const weldmailInboxSchema = z.object({
  accountIds: z.array(z.string()).default([]),
  folder: z.enum(folderValues).default('inbox'),
  unreadOnly: z.boolean().default(false),
  importantOnly: z.boolean().default(false),
  starredOnly: z.boolean().default(false),
  hasAttachment: z.boolean().default(false),
  fromContains: z.string().default(''),
  subjectContains: z.string().default(''),
  maxCount: z.number().refine((n) => [5, 10, 20, 50].includes(n)).default(10),
  sort: z.enum(sortValues).default('newest'),
});
export type WeldmailInboxSettings = z.infer<typeof weldmailInboxSchema>;

interface ApiMailAccount { id: string; email?: string; displayName?: string }
interface ApiMailMessage {
  id: string;
  accountId?: string;
  subject?: string;
  // Newer app-api responses use `from`/`fromEmail`/`preview`/`date`/`hasAttachments`,
  // while some older shapes use `fromName`/`fromAddress`/`snippet`/`receivedAt`/`hasAttachment`.
  from?: string | { name?: string; email?: string; avatarUrl?: string | null };
  fromName?: string;
  fromEmail?: string;
  fromAddress?: string;
  fromAvatarUrl?: string | null;
  preview?: string;
  snippet?: string;
  bodyText?: string;
  date?: string;
  receivedAt?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  isPinned?: boolean;
  hasAttachment?: boolean;
  hasAttachments?: boolean;
  labels?: string[];
}

function mapMessage(api: ApiMailMessage, fallbackAccountId: string): MailRow {
  const fromObj = typeof api.from === 'object' && api.from !== null ? api.from : undefined;
  const fromString = typeof api.from === 'string' ? api.from : undefined;
  const emailAddr = api.fromEmail ?? api.fromAddress ?? fromObj?.email;
  const displayName = api.fromName ?? fromObj?.name ?? fromString ?? emailAddr ?? '—';
  const dateRaw = api.date ?? api.receivedAt;
  const date = dateRaw ? new Date(dateRaw) : new Date();
  const isRead = api.isRead !== false;
  return {
    id: api.id,
    accountId: api.accountId ?? fallbackAccountId,
    name: displayName,
    email: emailAddr,
    avatarUrl: api.fromAvatarUrl ?? fromObj?.avatarUrl ?? undefined,
    subject: api.subject ?? '(no subject)',
    preview: api.preview ?? api.snippet ?? api.bodyText?.slice(0, 200) ?? '',
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    isRead,
    isStarred: api.isStarred === true,
    isPinned: api.isPinned === true,
    hasAttachments: api.hasAttachments === true || api.hasAttachment === true,
    labels: api.labels ?? [],
    messageCount: 1,
    unreadCount: isRead ? 0 : 1,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- settings kept for the client-side filters described below, not yet implemented
function applyClientFilters(rows: MailRow[], _s: WeldmailInboxSettings): MailRow[] {
  // Most server-side filters happen via API query params; sorting & a few
  // fixture-style filters are applied here as a safety net.
  return rows;
}

function Render({ settings }: { settings: WeldmailInboxSettings }) {
  const accountsRes = useMailAccounts();
  const accounts = ((accountsRes.data as { data?: ApiMailAccount[] } | undefined)?.data ?? []) as ApiMailAccount[];
  const activeAccountIds = settings.accountIds.length > 0 ? settings.accountIds : accounts.map((a) => a.id);
  const primaryAccountId = activeAccountIds[0] ?? '';

  const messagesRes = useMailMessages(
    primaryAccountId,
    {
      folder: settings.folder === 'all' ? undefined : settings.folder,
      pageSize: Math.max(settings.maxCount * 2, 20),
    },
    !!primaryAccountId,
  );
  const apiRows = ((messagesRes.data as { data?: ApiMailMessage[] } | undefined)?.data ?? []) as ApiMailMessage[];
  const rows = applyClientFilters(apiRows.map((m) => mapMessage(m, primaryAccountId)), settings).slice(0, settings.maxCount);

  return <MailCard rows={rows} isLoading={messagesRes.isLoading && !!primaryAccountId} />;
}

function SettingsForm({
  value,
  onChange,
}: {
  value: WeldmailInboxSettings;
  onChange: (next: WeldmailInboxSettings) => void;
}) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  const accountsRes = useMailAccounts();
  const accounts = ((accountsRes.data as { data?: ApiMailAccount[] } | undefined)?.data ?? []) as ApiMailAccount[];

  const toggle = (key: keyof WeldmailInboxSettings, v: boolean) => onChange({ ...value, [key]: v });
  const toggleAccount = (id: string) => {
    const next = value.accountIds.includes(id) ? value.accountIds.filter((x) => x !== id) : [...value.accountIds, id];
    onChange({ ...value, accountIds: next });
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="mb-2 block">{f.accounts}</Label>
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : (
          <div className="grid grid-cols-1 gap-1.5">
            {accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={value.accountIds.length === 0 || value.accountIds.includes(a.id)}
                  onCheckedChange={() => toggleAccount(a.id)}
                />
                <span className="truncate">{a.displayName ?? a.email ?? a.id}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <Label className="mb-2 block">{f.folder}</Label>
        <Select value={value.folder} onValueChange={(v) => onChange({ ...value, folder: v as WeldmailInboxSettings['folder'] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inbox">{f.folderInbox}</SelectItem>
            <SelectItem value="sent">{f.folderSent}</SelectItem>
            <SelectItem value="drafts">{f.folderDrafts}</SelectItem>
            <SelectItem value="archive">{f.folderArchive}</SelectItem>
            <SelectItem value="all">{f.folderAll}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ToggleRow label={f.unreadOnly} checked={value.unreadOnly} onChange={(v) => toggle('unreadOnly', v)} />
        <ToggleRow label={f.importantOnly} checked={value.importantOnly} onChange={(v) => toggle('importantOnly', v)} />
        <ToggleRow label={f.starredOnly} checked={value.starredOnly} onChange={(v) => toggle('starredOnly', v)} />
        <ToggleRow label={f.hasAttachment} checked={value.hasAttachment} onChange={(v) => toggle('hasAttachment', v)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-2 block">{f.fromContains}</Label>
          <Input value={value.fromContains} onChange={(e) => onChange({ ...value, fromContains: e.target.value })} placeholder="acme.com" />
        </div>
        <div>
          <Label className="mb-2 block">{f.subjectContains}</Label>
          <Input value={value.subjectContains} onChange={(e) => onChange({ ...value, subjectContains: e.target.value })} placeholder="invoice" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-2 block">{f.maxRows}</Label>
          <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {[5, 10, 20, 50].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-2 block">{f.sort}</Label>
          <Select value={value.sort} onValueChange={(v) => onChange({ ...value, sort: v as WeldmailInboxSettings['sort'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{f.sortNewest}</SelectItem>
              <SelectItem value="oldest">{f.sortOldest}</SelectItem>
              <SelectItem value="unread">{f.sortUnreadFirst}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

export const weldmailInboxWidget: HomeWidgetDefinition<WeldmailInboxSettings> = {
  id: 'weldmail-inbox',
  module: 'weldmail',
  title: 'WeldMail inbox',
  description: 'Recent emails',
  icon: Mail,
  schema: weldmailInboxSchema,
  defaultSettings: weldmailInboxSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};

import { useState } from 'react';
import { Building2, Hash, Loader2, Plus, TicketCheck, X, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  MERGE_RECORD_TYPES,
  type MergeIssueDetailDto,
  type MergeRecordLinkDto,
  type MergeRecordType,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { useObjectPanel } from '@/components/object-panel';
import { useCreateMergeIssueLink, useRemoveMergeIssueLink } from '@/hooks/queries/use-weldmerge-across-queries';
import { useI18n } from '@/lib/i18n/provider';

export const RECORD_LINK_ICON: Record<MergeRecordType, LucideIcon> = {
  desk_ticket: TicketCheck,
  crm_company: Building2,
  chat_channel: Hash,
};

/** The object panel each kind of record opens in. */
export const RECORD_LINK_PANEL: Record<MergeRecordType, string> = {
  desk_ticket: 'ticket',
  crm_company: 'company',
  chat_channel: 'channel',
};

/**
 * The tickets, companies and chat channels linked to an issue, with a small
 * form to link another by id. Changing links needs `merge_issues:update`.
 */
export function IssueLinksPanel({
  issue,
  canEdit,
}: Readonly<{ issue: Pick<MergeIssueDetailDto, 'id' | 'recordLinks'>; canEdit: boolean }>) {
  const { t } = useI18n();
  const tl = t.weldmerge.across.issue.links;
  const panel = useObjectPanel();
  const create = useCreateMergeIssueLink(issue.id);
  const remove = useRemoveMergeIssueLink(issue.id);

  const [adding, setAdding] = useState(false);
  const [recordType, setRecordType] = useState<MergeRecordType>('desk_ticket');
  const [recordId, setRecordId] = useState('');
  const [title, setTitle] = useState('');

  const submit = async () => {
    const id = recordId.trim();
    if (id === '') return;
    try {
      await create.mutateAsync({ recordType, recordId: id, title: title.trim() === '' ? null : title.trim() });
      setRecordId('');
      setTitle('');
      setAdding(false);
      toast.success(tl.added);
    } catch {
      toast.error(tl.addFailed);
    }
  };

  const open = (link: MergeRecordLinkDto) => panel.open({ type: RECORD_LINK_PANEL[link.recordType], id: link.recordId });

  return (
    <div className="space-y-3">
      {issue.recordLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tl.empty}</p>
      ) : (
        <ul className="space-y-1">
          {issue.recordLinks.map((link) => {
            const Icon = RECORD_LINK_ICON[link.recordType];
            return (
              <li key={link.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => open(link)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  aria-label={`${tl.open} ${link.title ?? link.recordId}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-xs text-muted-foreground">{tl.type[link.recordType]}</span>
                  <span className="min-w-0 flex-1 truncate">{link.title ?? tl.untitled}</span>
                </button>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={tl.remove}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(link.id, { onError: () => toast.error(tl.removeFailed) })}
                  >
                    <X />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && !adding && (
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {tl.add}
        </Button>
      )}

      {canEdit && adding && (
        <div className="space-y-2 rounded-md border p-3">
          <Select value={recordType} onValueChange={(value) => setRecordType(value as MergeRecordType)}>
            <SelectTrigger size="sm" className="w-full" aria-label={tl.typeLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MERGE_RECORD_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {tl.type[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
            placeholder={tl.recordIdPlaceholder}
            aria-label={tl.recordId}
            className="h-8"
          />
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={tl.titlePlaceholder}
            aria-label={tl.titleLabel}
            className="h-8"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void submit()} disabled={create.isPending || recordId.trim() === ''}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {tl.submit}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
              {t.common.actions.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

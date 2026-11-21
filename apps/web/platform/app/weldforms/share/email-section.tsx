import { useDeferredValue, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { BellRing, Mail, UserX } from 'lucide-react';
import { toast } from 'sonner';
import {
  FORM_INVITATION_STATUSES,
  type FormDetail,
  type FormInvitation,
  type FormInvitationStatus,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Progress } from '@weldsuite/ui/components/progress';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import {
  useFormInvitationStats,
  useFormInvitations,
  useRemindInvitations,
  useRevokeInvitation,
} from '@/hooks/queries/use-weldforms-results-queries';
import { errorMessage } from '../results/form-gate';
import { InviteDialog } from './invite-dialog';

const STATUS_TONE: Record<FormInvitationStatus, SoftTone> = {
  sent: 'neutral',
  opened: 'neutral',
  started: 'warning',
  completed: 'success',
  revoked: 'danger',
};

/** The most recent thing that happened on an invitation. */
export function lastActivity(invitation: FormInvitation): string | null {
  return (
    invitation.completedAt ??
    invitation.startedAt ??
    invitation.openedAt ??
    invitation.sentAt
  );
}

/** Whether an invitation can still be reminded or revoked. */
function remindable(invitation: FormInvitation): boolean {
  return invitation.status !== 'completed' && invitation.status !== 'revoked';
}

export function EmailSection({ form, shareable }: Readonly<{ form: FormDetail; shareable: boolean }>) {
  const { t, format } = useI18n();
  const te = t.weldformsResults.share.email;
  const [status, setStatus] = useState<FormInvitationStatus | ''>('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [revoking, setRevoking] = useState<FormInvitation | null>(null);

  const canSend = form.permissions.send;
  const params = { ...(status ? { status } : {}), ...(deferredSearch ? { q: deferredSearch } : {}) };
  const list = useFormInvitations(form.id, params, canSend);
  const stats = useFormInvitationStats(form.id, canSend);
  const remind = useRemindInvitations(form.id);
  const revoke = useRevokeInvitation(form.id);

  const { invitations } = list;

  async function sendReminders(invitationIds?: string[]) {
    try {
      const res = await remind.mutateAsync(invitationIds ? { invitationIds } : {});
      toast.success(format(te.remindDone, { reminded: res.data.reminded, skipped: res.data.skipped }));
      setSelected([]);
    } catch (err) {
      toast.error(errorMessage(err, te.remindFailed));
    }
  }

  async function confirmRevoke(invitation: FormInvitation) {
    try {
      await revoke.mutateAsync(invitation.id);
      toast.success(te.revokeDone);
      setSelected((current) => current.filter((id) => id !== invitation.id));
    } catch (err) {
      toast.error(errorMessage(err, te.revokeFailed));
    } finally {
      setRevoking(null);
    }
  }

  if (!canSend) {
    return (
      <SectionCard title={te.title} description={te.description}>
        <InfoBanner variant="neutral">{te.noPermission}</InfoBanner>
      </SectionCard>
    );
  }

  const s = stats.data;
  const statEntries: Array<[keyof typeof te.stats, number]> = s
    ? [
        ['total', s.total],
        ['sent', s.sent],
        ['opened', s.opened],
        ['started', s.started],
        ['completed', s.completed],
        ['revoked', s.revoked],
      ]
    : [];

  let listContent: ReactNode;
  if (list.isLoading) listContent = <PageLoader fullScreen={false} className="min-h-40" />;
  else if (list.error) listContent = <ErrorState onRetry={() => void list.refetch()} />;
  else if (invitations.length > 0) {
    listContent = <InvitationsTable invitations={invitations} selected={selected} onSelectedChange={setSelected} onRevoke={setRevoking} />;
  } else if (deferredSearch || status) {
    listContent = <EmptyState icon={Mail} title={te.noResultsTitle} description={te.noResultsDescription} />;
  } else {
    listContent = <EmptyState icon={Mail} title={te.emptyTitle} description={te.emptyDescription} />;
  }

  return (
    <SectionCard
      title={te.title}
      description={te.description}
      action={
        <Button type="button" disabled={!shareable} onClick={() => setInviteOpen(true)}>
          <Mail className="mr-1.5 h-4 w-4" />
          {te.invite}
        </Button>
      }
    >
      <div className="space-y-4">
        {!shareable && <InfoBanner variant="warning">{te.shareFirst}</InfoBanner>}

        {s && s.total > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {statEntries.map(([key, value]) => (
                <span key={key} className="rounded-md border px-3 py-1.5 text-sm">
                  <span className="text-muted-foreground">{te.stats[key]}</span>{' '}
                  <span className="font-semibold tabular-nums">{value}</span>
                </span>
              ))}
            </div>
            <div className="space-y-1">
              <Progress value={(s.completed / s.total) * 100} aria-label={format(te.progress, { completed: s.completed, total: s.total })} />
              <p className="text-xs text-muted-foreground">{format(te.progress, { completed: s.completed, total: s.total })}</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={te.searchPlaceholder}
            aria-label={te.searchPlaceholder}
            className="w-full sm:w-64"
          />
          <FilterSelect
            value={status || undefined}
            onChange={(value) => setStatus((value as FormInvitationStatus | undefined) ?? '')}
            options={FORM_INVITATION_STATUSES.map((value) => ({ value, label: te.status[value] }))}
            allLabel={te.statusFilter}
            ariaLabel={te.statusFilter}
          />
          <div className="ml-auto flex flex-wrap gap-2">
            {selected.length > 0 && (
              <Button type="button" variant="outline" disabled={remind.isPending} onClick={() => void sendReminders(selected)}>
                <BellRing className="mr-1.5 h-4 w-4" />
                {format(te.remindSelected, { count: selected.length })}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={remind.isPending || !shareable || (s?.total ?? 0) === 0}
              onClick={() => void sendReminders()}
            >
              <BellRing className="mr-1.5 h-4 w-4" />
              {te.remindAll}
            </Button>
          </div>
        </div>

        {listContent}

        {list.hasNextPage && (
          <div className="flex justify-center">
            <Button type="button" variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t.weldformsResults.common.loadMore}
            </Button>
          </div>
        )}
      </div>

      <InviteDialog formId={form.id} open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={te.revokeTitle}
        description={revoking ? format(te.revokeDescription, { email: revoking.email }) : ''}
        variant="destructive"
        confirmLabel={te.revoke}
        cancelLabel={t.weldformsResults.common.cancel}
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) void confirmRevoke(revoking);
        }}
      />
    </SectionCard>
  );
}

function InvitationsTable({
  invitations,
  selected,
  onSelectedChange,
  onRevoke,
}: Readonly<{
  invitations: FormInvitation[];
  selected: string[];
  onSelectedChange: Dispatch<SetStateAction<string[]>>;
  onRevoke: (invitation: FormInvitation) => void;
}>) {
  const { t, format, language } = useI18n();
  const te = t.weldformsResults.share.email;
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
  const allSelected = invitations.length > 0 && invitations.every((i) => selected.includes(i.id));

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label={te.table.selectAll}
                checked={allSelected}
                onCheckedChange={(checked) =>
                  onSelectedChange(checked === true ? invitations.filter(remindable).map((i) => i.id) : [])
                }
              />
            </TableHead>
            <TableHead>{te.table.recipient}</TableHead>
            <TableHead>{te.table.status}</TableHead>
            <TableHead className="hidden md:table-cell">{te.table.reminders}</TableHead>
            <TableHead className="hidden md:table-cell">{te.table.sent}</TableHead>
            <TableHead className="hidden lg:table-cell">{te.table.activity}</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((invitation) => {
            const activity = lastActivity(invitation);
            return (
              <TableRow key={invitation.id}>
                <TableCell>
                  <Checkbox
                    aria-label={format(te.table.selectRow, { email: invitation.email })}
                    disabled={!remindable(invitation)}
                    checked={selected.includes(invitation.id)}
                    onCheckedChange={(checked) =>
                      onSelectedChange((current) =>
                        checked === true ? [...new Set([...current, invitation.id])] : current.filter((id) => id !== invitation.id),
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{invitation.name ?? invitation.email}</p>
                    {invitation.name && <p className="truncate text-xs text-muted-foreground">{invitation.email}</p>}
                  </div>
                </TableCell>
                <TableCell>
                  <SoftBadge tone={STATUS_TONE[invitation.status]}>{te.status[invitation.status]}</SoftBadge>
                </TableCell>
                <TableCell className="hidden text-sm tabular-nums md:table-cell" title={invitation.lastRemindedAt ? format(te.lastReminded, { date: date.format(new Date(invitation.lastRemindedAt)) }) : undefined}>
                  {invitation.remindersSent}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                  {invitation.sentAt ? date.format(new Date(invitation.sentAt)) : t.weldformsResults.common.noValue}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                  {activity ? date.format(new Date(activity)) : t.weldformsResults.common.noValue}
                </TableCell>
                <TableCell>
                  {remindable(invitation) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${te.revoke} ${invitation.email}`}
                      onClick={() => onRevoke(invitation)}
                    >
                      <UserX className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

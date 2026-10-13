import { useState } from 'react';
import { Ellipsis, Loader2, Mailbox, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReachMailbox } from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteReachMailbox,
  usePauseReachMailbox,
  useReachAccess,
  useReachDomains,
  useReachMailboxes,
  useResumeReachMailbox,
} from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { useReachFormat } from '@/lib/reach/format';
import { MailboxStatusBadge, WarmupSummary } from '../components/status';
import { EmptyPanel, ErrorPanel, SectionCard } from '../components/page-kit';
import { warmupCopyParams } from '../lib/warmup';
import { CreateMailboxDialog, EditMailboxDialog } from './mailbox-dialogs';

export function MailboxesSection() {
  const t = useTranslations();
  const format = useReachFormat();
  const { can } = usePermissions();
  const mailboxes = useReachMailboxes();
  const domains = useReachDomains();
  const access = useReachAccess();

  const [createOpen, setCreateOpen] = useState(false);
  const [toEdit, setToEdit] = useState<ReachMailbox | null>(null);
  const [toDelete, setToDelete] = useState<ReachMailbox | null>(null);

  const pause = usePauseReachMailbox();
  const resume = useResumeReachMailbox();
  const remove = useDeleteReachMailbox();

  const canCreate = can('reach_mailboxes:create');
  const canUpdate = can('reach_mailboxes:update');
  const canDelete = can('reach_mailboxes:delete');

  const visible = (mailboxes.data ?? []).filter((mailbox) => mailbox.status !== 'deleted');
  const limit = access.data?.limits.maxMailboxes;
  const atLimit = limit !== undefined && (access.data?.usage.mailboxes ?? 0) >= limit;
  const hasConnectedDomain = (domains.data ?? []).some((domain) => domain.status === 'active');
  const warmupParams = warmupCopyParams();

  const run = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      toast.success(successMessage);
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    await run(() => remove.mutateAsync(toDelete.id), t('reach.mailboxes.delete.deleted'));
    setToDelete(null);
  };

  const createButton = canCreate ? (
    <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!hasConnectedDomain || atLimit}>
      <Plus className="mr-1.5 h-4 w-4" />
      {t('reach.mailboxes.list.create')}
    </Button>
  ) : undefined;

  return (
    <SectionCard
      title={t('reach.mailboxes.list.title')}
      description={
        limit === undefined
          ? t('reach.mailboxes.list.description', warmupParams)
          : `${t('reach.mailboxes.list.description', warmupParams)} ${t('reach.mailboxes.list.limitHint', {
              used: access.data?.usage.mailboxes ?? 0,
              limit,
            })}`
      }
      action={createButton}
    >
      {mailboxes.isPending && (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('reach.common.loading')}
        </div>
      )}
      {mailboxes.isError && <ErrorPanel onRetry={() => void mailboxes.refetch()} />}
      {mailboxes.data && visible.length === 0 && (
        <EmptyPanel
          icon={Mailbox}
          title={t('reach.mailboxes.list.empty')}
          description={hasConnectedDomain ? t('reach.mailboxes.list.emptyHint') : t('reach.mailboxes.list.emptyNoDomain')}
          action={hasConnectedDomain ? createButton : undefined}
        />
      )}
      {visible.length > 0 && (
        <InfoBanner variant="info" className="mb-4">
          {t('reach.mailboxes.warmup.info')}
        </InfoBanner>
      )}
      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reach.mailboxes.list.columns.mailbox')}</TableHead>
                <TableHead>{t('reach.mailboxes.list.columns.type')}</TableHead>
                <TableHead>{t('reach.mailboxes.list.columns.status')}</TableHead>
                <TableHead>{t('reach.mailboxes.list.columns.warmup')}</TableHead>
                <TableHead className="text-right">{t('reach.mailboxes.list.columns.sent')}</TableHead>
                <TableHead>{t('reach.mailboxes.list.columns.lastSent')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('reach.mailboxes.list.columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((mailbox) => {
                const cap = Math.min(mailbox.rampCurrent, mailbox.dailyCap);
                const canPause = mailbox.status === 'active' || mailbox.status === 'warming';
                const canResume = mailbox.status === 'paused';
                const busy =
                  (pause.isPending && pause.variables === mailbox.id) ||
                  (resume.isPending && resume.variables === mailbox.id);
                return (
                  <TableRow key={mailbox.id}>
                    <TableCell>
                      <p className="font-medium">{mailbox.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {mailbox.firstName} {mailbox.lastName}
                      </p>
                      {mailbox.pausedReason && (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                          {t('reach.mailboxes.list.pausedReason', { reason: mailbox.pausedReason })}
                        </p>
                      )}
                      {mailbox.lastError && (
                        <p className="mt-1 max-w-xs truncate text-xs text-destructive" title={mailbox.lastError}>
                          {t('reach.mailboxes.list.errorReason', { error: mailbox.lastError })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t(`reach.mailboxTypes.${mailbox.type}`)}</TableCell>
                    <TableCell>
                      <MailboxStatusBadge status={mailbox.status} />
                    </TableCell>
                    <TableCell>
                      <WarmupSummary mailbox={mailbox} />
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums"
                      title={t('reach.mailboxes.list.sentTodayHint', { cap, max: mailbox.dailyCap })}
                    >
                      {t('reach.mailboxes.list.sentToday', { sent: mailbox.sentToday, cap })}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {mailbox.lastSentAt ? format.relative(mailbox.lastSentAt) : t('reach.common.never')}
                    </TableCell>
                    <TableCell>
                      {(canUpdate || canDelete) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.actions.openMenu')}>
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ellipsis className="h-4 w-4" />}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canUpdate && (
                              <DropdownMenuItem onSelect={() => setToEdit(mailbox)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                {t('reach.mailboxes.actions.edit')}
                              </DropdownMenuItem>
                            )}
                            {canUpdate && canPause && (
                              <DropdownMenuItem
                                onSelect={() => void run(() => pause.mutateAsync(mailbox.id), t('reach.mailboxes.actions.paused'))}
                              >
                                <Pause className="mr-2 h-4 w-4" />
                                {t('reach.mailboxes.actions.pause')}
                              </DropdownMenuItem>
                            )}
                            {canUpdate && canResume && (
                              <DropdownMenuItem
                                onSelect={() => void run(() => resume.mutateAsync(mailbox.id), t('reach.mailboxes.actions.resumed'))}
                              >
                                <Play className="mr-2 h-4 w-4" />
                                {t('reach.mailboxes.actions.resume')}
                              </DropdownMenuItem>
                            )}
                            {canDelete && mailbox.status !== 'deleting' && (
                              <>
                                {canUpdate && <DropdownMenuSeparator />}
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => setToDelete(mailbox)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {t('reach.mailboxes.actions.delete')}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateMailboxDialog open={createOpen} onOpenChange={setCreateOpen} domains={domains.data ?? []} />
      <EditMailboxDialog mailbox={toEdit} onOpenChange={(open) => !open && setToEdit(null)} />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        variant="destructive"
        title={t('reach.mailboxes.delete.title', { email: toDelete?.email ?? '' })}
        description={t('reach.mailboxes.delete.description')}
        confirmLabel={t('reach.mailboxes.delete.confirm')}
        cancelLabel={t('common.actions.cancel')}
        loading={remove.isPending}
        onConfirm={handleDelete}
      />
    </SectionCard>
  );
}

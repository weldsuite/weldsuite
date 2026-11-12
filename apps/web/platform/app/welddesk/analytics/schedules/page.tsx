/**
 * WeldDesk → Reports → Scheduled reports: the overview or a saved report,
 * emailed on a schedule (TASK-1228).
 */

import { useState, type ReactNode } from 'react';
import { CalendarClock, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { HelpdeskReportScheduleDto } from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useDeleteDeskReportSchedule,
  useDeskReportSchedules,
  useSendDeskReportSchedule,
  useUpdateDeskReportSchedule,
} from '@/hooks/queries/use-desk-reports-queries';
import { ScheduleDialog } from './schedule-dialog';
import { recipientsLabel, scheduleSubject, scheduleWhen } from './schedule-labels';

type Editing = { schedule: HelpdeskReportScheduleDto | null } | null;

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function DeskReportSchedulesPage() {
  const { t } = useI18n();
  const ts = t.helpdesk.reportSchedules;
  const tr = t.helpdesk.reports;
  const canCreate = useCan('settings:create');
  const canUpdate = useCan('settings:update');
  const canDelete = useCan('settings:delete');
  const { data, isLoading, isError, refetch } = useDeskReportSchedules();
  const update = useUpdateDeskReportSchedule();
  const send = useSendDeskReportSchedule();
  const remove = useDeleteDeskReportSchedule();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<HelpdeskReportScheduleDto | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tr.title, href: '/welddesk/reports' },
    { label: ts.title },
  ]);

  const sendNow = (schedule: HelpdeskReportScheduleDto) => {
    setSendingId(schedule.id);
    send.mutate(schedule.id, {
      onSuccess: (result) => {
        if (result.status === 'sent') {
          toast.success(
            schedule.recipients.length === 1
              ? ts.sendNow.sentOne
              : ts.sendNow.sent.replace('{count}', String(schedule.recipients.length)),
          );
        } else {
          toast.error(result.error ? ts.sendNow.failed.replace('{error}', result.error) : ts.sendNow.failedUnknown);
        }
      },
      onError: () => toast.error(ts.sendNow.requestFailed),
      onSettled: () => setSendingId(null),
    });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(ts.deleted);
      setDeleting(null);
    } catch {
      toast.error(ts.deleteFailed);
    }
  };

  const columns: ListTableColumn<HelpdeskReportScheduleDto>[] = [
    { id: 'name', header: ts.columns.name, cell: (row) => <span className="font-medium">{row.name}</span> },
    {
      id: 'report',
      header: ts.columns.report,
      cell: (row) => {
        const subject = scheduleSubject(row, ts);
        return subject.deleted ? <SoftBadge tone="danger">{subject.label}</SoftBadge> : subject.label;
      },
    },
    { id: 'when', header: ts.columns.when, cell: (row) => scheduleWhen(row, ts) },
    {
      id: 'recipients',
      header: ts.columns.recipients,
      cell: (row) => <span title={row.recipients.join(', ')}>{recipientsLabel(row.recipients.length, ts)}</span>,
    },
    {
      id: 'nextRun',
      header: ts.columns.nextRun,
      cell: (row) => (row.nextRunAt ? formatDateTime(row.nextRunAt) : <span className="text-muted-foreground">{ts.notScheduled}</span>),
    },
    {
      id: 'lastRun',
      header: ts.columns.lastRun,
      cell: (row) =>
        row.lastRunAt === null && row.lastStatus === null ? (
          <span className="text-muted-foreground">{ts.neverRun}</span>
        ) : (
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              {row.lastStatus && (
                <SoftBadge tone={row.lastStatus === 'sent' ? 'success' : 'danger'}>{ts.status[row.lastStatus]}</SoftBadge>
              )}
              {row.lastRunAt && <span className="text-muted-foreground">{formatDateTime(row.lastRunAt)}</span>}
            </div>
            {row.lastError && <p className="text-xs text-destructive">{row.lastError}</p>}
          </div>
        ),
    },
    {
      id: 'enabled',
      header: ts.columns.enabled,
      width: 'w-[70px]',
      cell: (row) => (
        <Switch
          aria-label={`${ts.columns.enabled}: ${row.name}`}
          checked={row.enabled}
          disabled={!canUpdate || update.isPending}
          onCheckedChange={(enabled) =>
            update.mutate({ id: row.id, input: { enabled } }, { onError: () => toast.error(ts.toggleFailed) })
          }
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[130px]',
      align: 'right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          {canUpdate && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${ts.actions.edit}: ${row.name}`}
              onClick={() => setEditing({ schedule: row })}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {canUpdate && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${sendingId === row.id ? ts.actions.sending : ts.actions.sendNow}: ${row.name}`}
              disabled={sendingId === row.id}
              onClick={() => sendNow(row)}
            >
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${ts.actions.delete}: ${row.name}`}
              onClick={() => setDeleting(row)}
            >
              <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const createButton = canCreate ? (
    <Button size="sm" onClick={() => setEditing({ schedule: null })}>
      <Plus className="mr-2 h-4 w-4" aria-hidden />
      {ts.create}
    </Button>
  ) : null;

  let body: ReactNode;
  if (isLoading) body = <PageLoader fullScreen={false} />;
  else if (isError || !data) body = <ErrorState message={ts.loadError} onRetry={() => void refetch()} />;
  else if (data.length === 0) {
    body = <EmptyState icon={CalendarClock} title={ts.emptyTitle} description={ts.emptyDescription} action={createButton} />;
  } else {
    body = <ListTable columns={columns} data={data} rowKey={(row) => row.id} emptyMessage={ts.emptyTitle} dense />;
  }

  return (
    <DashboardPage title={ts.title} description={ts.description} actions={data && data.length > 0 ? createButton : null}>
      {body}
      {editing && (
        <ScheduleDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          schedule={editing.schedule}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={ts.deleteTitle}
        description={deleting ? ts.deleteDescription.replace('{name}', deleting.name) : ''}
        confirmLabel={ts.actions.delete}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </DashboardPage>
  );
}

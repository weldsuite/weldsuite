/**
 * Alerts: every alert of the current project with its state, and the actions
 * on each (edit, history, test, snooze, turn on or off, delete).
 * `?alert=<id>` opens one in the side sheet: the link alert emails and
 * notifications carry.
 */

import { useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useCan } from '@weldsuite/permissions/react';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useDeleteWeldPanelAlert, useSnoozeWeldPanelAlert, useTestWeldPanelAlert, useUpdateWeldPanelAlert, useWeldPanelAlerts } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { deliveryReportText } from '../components/delivery-channels-fields';
import { useMembers } from '../components/use-members';
import { daysFromNow } from '../lib/date-input';
import { formatDateTime } from '../lib/format';
import { AlertDetailSheet } from './alert-detail-sheet';
import { AlertFormDialog } from './alert-form-dialog';
import { AlertStateBadge, useConditionText, useWatchText } from './alert-text';

type Scope = 'all' | 'mine';

const HOUR_MS = 3_600_000;

interface AlertMenuItemsProps {
  alert: PanelAlertDto;
  canChange: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** The row's menu: history, edit, test, snooze, turn on or off, delete. */
function AlertMenuItems({ alert, canChange, canDelete, onOpen, onEdit, onDelete }: Readonly<AlertMenuItemsProps>) {
  const { t, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tch = t.weldpanel.collab.channels.delivery;
  const update = useUpdateWeldPanelAlert();
  const snooze = useSnoozeWeldPanelAlert();
  const test = useTestWeldPanelAlert();
  const snoozed = alert.snoozedUntil !== null && Date.parse(alert.snoozedUntil) > Date.now();

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast.success(done);
    } catch {
      toast.error(ta.failed);
    }
  }

  async function sendTest() {
    try {
      const report = await test.mutateAsync(alert.id);
      toast.success(ta.tested, {
        description: deliveryReportText(report, tch, format),
      });
    } catch {
      toast.error(ta.testFailed);
    }
  }

  return (
    <>
      <DropdownMenuItem onSelect={onOpen}>{ta.actions.history}</DropdownMenuItem>
      {canChange && (
        <>
          <DropdownMenuItem onSelect={onEdit}>{ta.actions.edit}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void sendTest()}>{ta.actions.test}</DropdownMenuItem>
          {snoozed ? (
            <DropdownMenuItem onSelect={() => void run(() => snooze.mutateAsync({ id: alert.id, until: null }), ta.unsnoozedToast)}>{ta.actions.unsnooze}</DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{ta.actions.snooze}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: new Date(Date.now() + HOUR_MS).toISOString(),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1h}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: daysFromNow(1),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1d}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: daysFromNow(7),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1w}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            onSelect={() =>
              void run(
                () =>
                  update.mutateAsync({
                    id: alert.id,
                    enabled: !alert.enabled,
                  }),
                alert.enabled ? ta.disabledToast : ta.enabledToast,
              )
            }
          >
            {alert.enabled ? ta.actions.disable : ta.actions.enable}
          </DropdownMenuItem>
        </>
      )}
      {canDelete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
            {ta.actions.delete}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

function AlertsList({
  projectId,
  creating,
  onCreatingChange,
}: Readonly<{
  projectId: string;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}>) {
  const { t, language, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('alert');
  const conditionText = useConditionText();
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const canManage = useCan('panel_projects:manage');
  const { me } = useMembers();
  const [scope, setScope] = useState<Scope>('all');
  const [editing, setEditing] = useState<PanelAlertDto | null>(null);
  const [deleting, setDeleting] = useState<PanelAlertDto | null>(null);
  const { data: alerts, isLoading, isError, refetch } = useWeldPanelAlerts({ projectId, scope });
  const { data: reports } = useWeldPanelReports({ projectId });
  const remove = useDeleteWeldPanelAlert();
  const watchText = useWatchText();
  const reportsById = useMemo(() => new Map((reports ?? []).map((r) => [r.id, r])), [reports]);

  const setOpen = (id: string | null) => router.replace(id ? `/weldpanel/alerts?alert=${encodeURIComponent(id)}` : '/weldpanel/alerts');
  const mayChange = (alert: PanelAlertDto) => alert.ownerUserId === me || canManage;

  const columns: ColumnDef<PanelAlertDto>[] = [
    {
      id: 'name',
      header: ta.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (alert) => <span className="block truncate font-medium">{alert.name}</span>,
    },
    {
      id: 'watch',
      header: ta.detail.watching,
      width: 'hidden lg:block lg:w-[200px]',
      render: (alert) => <span className="block truncate text-muted-foreground">{watchText(alert, reportsById)}</span>,
    },
    {
      id: 'condition',
      header: ta.columns.condition,
      width: 'hidden md:block md:w-[180px]',
      render: (alert) => <span className="block truncate">{conditionText(alert.condition)}</span>,
    },
    {
      id: 'interval',
      header: ta.columns.interval,
      width: 'hidden lg:block lg:w-[100px]',
      render: (alert) => <span className="block truncate text-muted-foreground">{ta.intervals[alert.checkInterval]}</span>,
    },
    {
      id: 'state',
      header: ta.columns.state,
      width: 'w-[110px]',
      render: (alert) => <AlertStateBadge alert={alert} />,
    },
    {
      id: 'snoozed',
      header: ta.actions.snooze,
      width: 'hidden xl:block xl:w-[170px]',
      render: (alert) =>
        alert.snoozedUntil !== null && Date.parse(alert.snoozedUntil) > Date.now() ? (
          <span className="block truncate text-muted-foreground">
            {format(ta.snoozed, {
              date: formatDateTime(alert.snoozedUntil, language),
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    },
    {
      id: 'lastChecked',
      header: ta.columns.lastChecked,
      width: 'hidden md:block md:w-[150px]',
      render: (alert) => (
        <span className="block truncate whitespace-nowrap tabular-nums text-muted-foreground">
          {alert.lastCheckedAt ? formatDateTime(alert.lastCheckedAt, language) : ta.detail.never}
        </span>
      ),
    },
  ];

  // The shared list words its own loading state in English only.
  if (isLoading && !alerts) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={ta.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const createAction = canCreate ? { label: ta.newAlert, onClick: () => onCreatingChange(true) } : undefined;

  return (
    <>
      <PanelEntityList<PanelAlertDto>
        items={alerts ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        rowMenu={(alert) => (
          <AlertMenuItems
            alert={alert}
            canChange={canUpdate && mayChange(alert)}
            canDelete={canDelete && mayChange(alert)}
            onOpen={() => setOpen(alert.id)}
            onEdit={() => setEditing(alert)}
            onDelete={() => setDeleting(alert)}
          />
        )}
        searchFields={['name']}
        searchPlaceholder={t.common.actions.search}
        leftActionButtons={
          <FilterSelect
            value={scope === 'all' ? undefined : scope}
            onChange={(next) => setScope((next as Scope | undefined) ?? 'all')}
            allLabel={ta.scopes.all}
            ariaLabel={ta.scopeLabel}
            options={[{ value: 'mine', label: ta.scopes.mine }]}
          />
        }
        onRowClick={(alert) => setOpen(alert.id)}
        createButton={createAction}
        emptyState={{
          icon: <Bell className="size-8 text-muted-foreground" />,
          title: scope === 'all' ? ta.emptyTitle : ta.noMatches,
          description: scope === 'all' ? ta.emptyDescription : '',
          action: scope === 'all' ? createAction : undefined,
        }}
        noResultsState={{
          icon: <Bell className="size-8 text-muted-foreground" />,
          title: ta.noMatches,
          description: '',
        }}
      />

      <AlertDetailSheet alertId={openId} onClose={() => setOpen(null)} reports={reportsById} />
      <AlertFormDialog open={creating} onOpenChange={onCreatingChange} projectId={projectId} />
      <AlertFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} projectId={projectId} alert={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(ta.deleteTitle, { name: deleting?.name ?? '' })}
        description={ta.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(ta.deleted);
            if (openId === deleting.id) setOpen(null);
            setDeleting(null);
          } catch {
            toast.error(ta.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function AlertsPage() {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsListPage title={ta.title}>{(project) => <AlertsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}</AnalyticsListPage>
  );
}

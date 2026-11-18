/**
 * Alerts: every alert of the current project with its state, and the actions
 * on each (edit, history, test, snooze, turn on or off, delete).
 * `?alert=<id>` opens one in the side sheet: the link alert emails and
 * notifications carry.
 */

import { useMemo, useState } from 'react';
import { Bell, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useDeleteWeldPanelAlert,
  useSnoozeWeldPanelAlert,
  useTestWeldPanelAlert,
  useUpdateWeldPanelAlert,
  useWeldPanelAlerts,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { deliveryReportText } from '../components/delivery-channels-fields';
import { useMembers } from '../components/use-members';
import { daysFromNow } from '../lib/date-input';
import { formatDateTime } from '../lib/format';
import { AlertDetailSheet } from './alert-detail-sheet';
import { AlertFormDialog } from './alert-form-dialog';
import { AlertStateBadge, useConditionText, useWatchText } from './alert-text';

type Scope = 'all' | 'mine';

const HOUR_MS = 3_600_000;

interface AlertRowProps {
  alert: PanelAlertDto;
  watch: string;
  canChange: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function AlertRow({ alert, watch, canChange, canDelete, onOpen, onEdit, onDelete }: Readonly<AlertRowProps>) {
  const { t, language, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tch = t.weldpanel.collab.channels.delivery;
  const conditionText = useConditionText();
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
      toast.success(ta.tested, { description: deliveryReportText(report, tch, format) });
    } catch {
      toast.error(ta.testFailed);
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-72">
        <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" onClick={onOpen}>
          {alert.name}
        </button>
        <p className="truncate text-xs text-muted-foreground">{watch}</p>
      </TableCell>
      <TableCell className="hidden md:table-cell">{conditionText(alert.condition)}</TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">{ta.intervals[alert.checkInterval]}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <AlertStateBadge alert={alert} />
          {snoozed && alert.snoozedUntil && <span className="text-xs text-muted-foreground">{format(ta.snoozed, { date: formatDateTime(alert.snoozedUntil, language) })}</span>}
        </div>
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{alert.lastCheckedAt ? formatDateTime(alert.lastCheckedAt, language) : ta.detail.never}</TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={format(ta.actions.menu, { name: alert.name })}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
                      <DropdownMenuItem onSelect={() => void run(() => snooze.mutateAsync({ id: alert.id, until: new Date(Date.now() + HOUR_MS).toISOString() }), ta.snoozedToast)}>
                        {ta.actions.snooze1h}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void run(() => snooze.mutateAsync({ id: alert.id, until: daysFromNow(1) }), ta.snoozedToast)}>{ta.actions.snooze1d}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void run(() => snooze.mutateAsync({ id: alert.id, until: daysFromNow(7) }), ta.snoozedToast)}>{ta.actions.snooze1w}</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem
                  onSelect={() => void run(() => update.mutateAsync({ id: alert.id, enabled: !alert.enabled }), alert.enabled ? ta.disabledToast : ta.enabledToast)}
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
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function AlertsList({ projectId, creating, onCreatingChange }: Readonly<{ projectId: string; creating: boolean; onCreatingChange: (open: boolean) => void }>) {
  const { t, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('alert');
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

  if (isError) return <ErrorState message={ta.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={scope === 'all' ? undefined : scope}
          onChange={(next) => setScope((next as Scope | undefined) ?? 'all')}
          allLabel={ta.scopes.all}
          ariaLabel={ta.scopeLabel}
          options={[{ value: 'mine', label: ta.scopes.mine }]}
        />
      </div>

      {isLoading && (
        <div className="grid gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {!isLoading && (alerts ?? []).length === 0 && (
        <EmptyState
          icon={Bell}
          title={scope === 'all' ? ta.emptyTitle : ta.noMatches}
          description={scope === 'all' ? ta.emptyDescription : undefined}
          action={
            canCreate && scope === 'all' ? (
              <Button size="sm" onClick={() => onCreatingChange(true)}>
                <Plus />
                {ta.newAlert}
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && alerts && alerts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ta.columns.name}</TableHead>
                <TableHead className="hidden md:table-cell">{ta.columns.condition}</TableHead>
                <TableHead className="hidden lg:table-cell">{ta.columns.interval}</TableHead>
                <TableHead>{ta.columns.state}</TableHead>
                <TableHead className="hidden md:table-cell">{ta.columns.lastChecked}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  watch={watchText(alert, reportsById)}
                  canChange={canUpdate && mayChange(alert)}
                  canDelete={canDelete && mayChange(alert)}
                  onOpen={() => setOpen(alert.id)}
                  onEdit={() => setEditing(alert)}
                  onDelete={() => setDeleting(alert)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

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
    </div>
  );
}

export default function AlertsPage() {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const canCreate = useCan('panel_reports:create');
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsPage
      title={ta.title}
      description={ta.description}
      actions={
        canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {ta.newAlert}
          </Button>
        ) : undefined
      }
    >
      {(project) => <AlertsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}
    </AnalyticsPage>
  );
}

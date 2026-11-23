/**
 * Alerts: every alert of the current project with its state, and the actions
 * on each (edit, history, test, snooze, turn on or off, delete). A row opens
 * the alert's record panel (`?stack=panel_alert:<id>`); `?alert=<id>`, the
 * link alert emails and notifications carry, opens it too.
 */

import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useCan } from '@weldsuite/permissions/react';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { PANEL_ALERT_TYPE, panelAlertHref } from '@/components/objects/panel-alert/panel-alert-tabs';
import { useDeleteWeldPanelAlert, useWeldPanelAlerts } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { useMembers } from '../components/use-members';
import { formatDateTime } from '../lib/format';
import { AlertFormDialog } from './alert-form-dialog';
import { AlertMenuItems } from './alert-menu';
import { AlertStateBadge, useConditionText, useWatchText } from './alert-text';

type Scope = 'all' | 'mine';

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

  // The open alert panel is kept in the URL (`?stack=`), so it survives a reload and can be linked to.
  useObjectPanelUrlSync('/weldpanel/alerts');
  const { stack, open: openPanel, closeAll } = useObjectPanel();
  // Alert emails and notifications link to `?alert=<id>`: show that alert's panel instead.
  useEffect(() => {
    if (openId) router.replace(panelAlertHref(openId));
  }, [openId, router]);
  const openAlert = (id: string, tab?: 'history') => openPanel({ type: PANEL_ALERT_TYPE, id, initialTab: tab });
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
            onOpen={() => openAlert(alert.id, 'history')}
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
        onRowClick={(alert) => openAlert(alert.id)}
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
            if (stack.some((handle) => handle.type === PANEL_ALERT_TYPE && handle.id === deleting.id)) closeAll();
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

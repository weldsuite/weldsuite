/**
 * Scheduled reports: who gets which report or dashboard when, with "send
 * now", turning one on or off, editing and deleting.
 */

import { useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelSubscriptionDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useCan } from '@weldsuite/permissions/react';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Switch } from '@weldsuite/ui/components/switch';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import {
  useDeleteWeldPanelSubscription,
  useSendWeldPanelSubscriptionNow,
  useUpdateWeldPanelSubscription,
  useWeldPanelSubscriptions,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelDashboards, useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { ChannelsSummary, deliveryReportText } from '../components/delivery-channels-fields';
import { useMembers } from '../components/use-members';
import { formatDateTime } from '../lib/format';
import { scheduleText } from '../lib/schedule';
import { SubscriptionFormDialog } from './subscription-form-dialog';

type Scope = 'all' | 'mine';

interface SubscriptionMenuItemsProps {
  subscription: PanelSubscriptionDto;
  canChange: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

/** The row's menu: edit, send now, delete. */
function SubscriptionMenuItems({ subscription, canChange, canDelete, onEdit, onDelete }: Readonly<SubscriptionMenuItemsProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const tch = t.weldpanel.collab.channels.delivery;
  const sendNow = useSendWeldPanelSubscriptionNow();

  async function send() {
    try {
      const report = await sendNow.mutateAsync(subscription.id);
      toast.success(ts.sent, {
        description: deliveryReportText(report, tch, format),
      });
    } catch {
      toast.error(ts.sendFailed);
    }
  }

  if (!canChange && !canDelete) return null;
  return (
    <>
      {canChange && <DropdownMenuItem onSelect={onEdit}>{ts.actions.edit}</DropdownMenuItem>}
      {canChange && <DropdownMenuItem onSelect={() => void send()}>{ts.actions.sendNow}</DropdownMenuItem>}
      {canDelete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
            {ts.actions.delete}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** The on/off switch of a row; it has its own mutation state. */
function EnabledSwitch({ subscription, canChange }: Readonly<{ subscription: PanelSubscriptionDto; canChange: boolean }>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const update = useUpdateWeldPanelSubscription();

  async function toggle(enabled: boolean) {
    try {
      await update.mutateAsync({ id: subscription.id, enabled });
      toast.success(enabled ? ts.enabledToast : ts.disabledToast);
    } catch {
      toast.error(ts.failed);
    }
  }

  return (
    <Switch
      checked={subscription.enabled}
      disabled={!canChange || update.isPending}
      onCheckedChange={(enabled) => void toggle(enabled)}
      aria-label={format(ts.toggleLabel, { name: subscription.name })}
    />
  );
}

function SubscriptionsList({
  projectId,
  creating,
  onCreatingChange,
}: Readonly<{
  projectId: string;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}>) {
  const { t, language, format } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const tc = t.weldpanel.analytics.common;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const canManage = useCan('panel_projects:manage');
  const { me } = useMembers();
  const [scope, setScope] = useState<Scope>('all');
  const [editing, setEditing] = useState<PanelSubscriptionDto | null>(null);
  const [deleting, setDeleting] = useState<PanelSubscriptionDto | null>(null);
  const { data: subscriptions, isLoading, isError, refetch } = useWeldPanelSubscriptions({ projectId, scope });
  const { data: reports } = useWeldPanelReports({ projectId });
  const { data: dashboards } = useWeldPanelDashboards({ projectId });
  const remove = useDeleteWeldPanelSubscription();
  const names = useMemo(() => new Map<string, string>([...(reports ?? []), ...(dashboards ?? [])].map((item) => [item.id, item.name])), [reports, dashboards]);
  const mayChange = (s: PanelSubscriptionDto) => s.ownerUserId === me || canManage;

  const columns: ColumnDef<PanelSubscriptionDto>[] = [
    {
      id: 'name',
      header: ts.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (subscription) => <span className="block truncate font-medium">{subscription.name}</span>,
    },
    {
      id: 'target',
      header: ts.columns.target,
      width: 'hidden sm:block sm:w-[180px]',
      render: (subscription) => <span className="block truncate">{names.get(subscription.targetId) ?? ts.missingTarget}</span>,
    },
    {
      id: 'targetType',
      header: t.weldpanel.analytics.common.type,
      width: 'hidden lg:block lg:w-[100px]',
      render: (subscription) => <span className="block truncate text-muted-foreground">{ts.targetTypes[subscription.targetType]}</span>,
    },
    {
      id: 'schedule',
      header: ts.columns.schedule,
      width: 'hidden md:block md:w-[260px]',
      render: (subscription) => <span className="block truncate">{scheduleText(subscription.schedule, ts.scheduleText, language, format)}</span>,
    },
    {
      id: 'channels',
      header: ts.columns.channels,
      width: 'hidden lg:block lg:w-[160px]',
      render: (subscription) => (
        <span className="block truncate text-muted-foreground">
          <ChannelsSummary channels={subscription.channels} />
        </span>
      ),
    },
    {
      id: 'nextRun',
      header: ts.columns.nextRun,
      width: 'hidden md:block md:w-[150px]',
      render: (subscription) => (
        <span className="block truncate whitespace-nowrap tabular-nums text-muted-foreground">
          {subscription.nextRunAt && subscription.enabled ? formatDateTime(subscription.nextRunAt, language) : '–'}
        </span>
      ),
    },
    {
      id: 'lastError',
      header: '',
      width: 'hidden xl:block xl:w-[200px]',
      render: (subscription) =>
        subscription.lastError ? <span className="block truncate text-destructive">{format(ts.lastError, { error: subscription.lastError })}</span> : null,
    },
    {
      id: 'enabled',
      header: ts.columns.enabled,
      width: 'w-[70px]',
      render: (subscription) => <EnabledSwitch subscription={subscription} canChange={canUpdate && mayChange(subscription)} />,
    },
  ];

  // The shared list words its own loading state in English only.
  if (isLoading && !subscriptions) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={ts.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const createAction = canCreate ? { label: ts.newSubscription, onClick: () => onCreatingChange(true) } : undefined;

  return (
    <>
      <PanelEntityList<PanelSubscriptionDto>
        items={subscriptions ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        rowMenu={(subscription) =>
          (canUpdate || canDelete) && mayChange(subscription) ? (
            <SubscriptionMenuItems
              subscription={subscription}
              canChange={canUpdate}
              canDelete={canDelete}
              onEdit={() => setEditing(subscription)}
              onDelete={() => setDeleting(subscription)}
            />
          ) : null
        }
        searchFields={['name']}
        searchPlaceholder={t.common.actions.search}
        leftActionButtons={
          <FilterSelect
            value={scope === 'all' ? undefined : scope}
            onChange={(next) => setScope((next as Scope | undefined) ?? 'all')}
            allLabel={ts.scopes.all}
            ariaLabel={ts.scopeLabel}
            options={[{ value: 'mine', label: ts.scopes.mine }]}
          />
        }
        onRowClick={canUpdate ? (subscription) => mayChange(subscription) && setEditing(subscription) : undefined}
        createButton={createAction}
        emptyState={{
          icon: <CalendarClock className="size-8 text-muted-foreground" />,
          title: scope === 'all' ? ts.emptyTitle : ts.noMatches,
          description: scope === 'all' ? ts.emptyDescription : '',
          action: scope === 'all' ? createAction : undefined,
        }}
        noResultsState={{
          icon: <CalendarClock className="size-8 text-muted-foreground" />,
          title: ts.noMatches,
          description: '',
        }}
      />

      <SubscriptionFormDialog open={creating} onOpenChange={onCreatingChange} projectId={projectId} />
      <SubscriptionFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} projectId={projectId} subscription={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(ts.deleteTitle, { name: deleting?.name ?? '' })}
        description={ts.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(ts.deleted);
            setDeleting(null);
          } catch {
            toast.error(ts.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function SubscriptionsPage() {
  const { t } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsListPage title={ts.title}>
      {(project) => <SubscriptionsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}
    </AnalyticsListPage>
  );
}

/**
 * Scheduled reports: who gets which report or dashboard when, with "send
 * now", turning one on or off, editing and deleting.
 */

import { useMemo, useState } from 'react';
import { CalendarClock, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelSubscriptionDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useDeleteWeldPanelSubscription,
  useSendWeldPanelSubscriptionNow,
  useUpdateWeldPanelSubscription,
  useWeldPanelSubscriptions,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelDashboards, useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChannelsSummary, deliveryReportText } from '../components/delivery-channels-fields';
import { useMembers } from '../components/use-members';
import { formatDateTime } from '../lib/format';
import { scheduleText } from '../lib/schedule';
import { SubscriptionFormDialog } from './subscription-form-dialog';

type Scope = 'all' | 'mine';

interface SubscriptionRowProps {
  subscription: PanelSubscriptionDto;
  targetName: string;
  canChange: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function SubscriptionRow({ subscription, targetName, canChange, canDelete, onEdit, onDelete }: Readonly<SubscriptionRowProps>) {
  const { t, language, format } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const tch = t.weldpanel.collab.channels.delivery;
  const update = useUpdateWeldPanelSubscription();
  const sendNow = useSendWeldPanelSubscriptionNow();

  async function toggle(enabled: boolean) {
    try {
      await update.mutateAsync({ id: subscription.id, enabled });
      toast.success(enabled ? ts.enabledToast : ts.disabledToast);
    } catch {
      toast.error(ts.failed);
    }
  }

  async function send() {
    try {
      const report = await sendNow.mutateAsync(subscription.id);
      toast.success(ts.sent, { description: deliveryReportText(report, tch, format) });
    } catch {
      toast.error(ts.sendFailed);
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-64">
        <p className="truncate font-medium">{subscription.name}</p>
        {subscription.lastError && <p className="truncate text-xs text-destructive">{format(ts.lastError, { error: subscription.lastError })}</p>}
      </TableCell>
      <TableCell className="max-w-56">
        <p className="truncate">{targetName}</p>
        <p className="text-xs text-muted-foreground">{ts.targetTypes[subscription.targetType]}</p>
      </TableCell>
      <TableCell className="hidden md:table-cell">{scheduleText(subscription.schedule, ts.scheduleText, language, format)}</TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        <ChannelsSummary channels={subscription.channels} />
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{subscription.nextRunAt && subscription.enabled ? formatDateTime(subscription.nextRunAt, language) : '–'}</TableCell>
      <TableCell>
        <Switch
          checked={subscription.enabled}
          disabled={!canChange || update.isPending}
          onCheckedChange={(enabled) => void toggle(enabled)}
          aria-label={format(ts.toggleLabel, { name: subscription.name })}
        />
      </TableCell>
      <TableCell>
        {(canChange || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={format(ts.actions.menu, { name: subscription.name })}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function SubscriptionsList({ projectId, creating, onCreatingChange }: Readonly<{ projectId: string; creating: boolean; onCreatingChange: (open: boolean) => void }>) {
  const { t, format } = useI18n();
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

  if (isError) return <ErrorState message={ts.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={scope === 'all' ? undefined : scope}
          onChange={(next) => setScope((next as Scope | undefined) ?? 'all')}
          allLabel={ts.scopes.all}
          ariaLabel={ts.scopeLabel}
          options={[{ value: 'mine', label: ts.scopes.mine }]}
        />
      </div>
      {isLoading && (
        <div className="grid gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {!isLoading && (subscriptions ?? []).length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title={scope === 'all' ? ts.emptyTitle : ts.noMatches}
          description={scope === 'all' ? ts.emptyDescription : undefined}
          action={
            canCreate && scope === 'all' ? (
              <Button size="sm" onClick={() => onCreatingChange(true)}>
                <Plus />
                {ts.newSubscription}
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && subscriptions && subscriptions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ts.columns.name}</TableHead>
                <TableHead>{ts.columns.target}</TableHead>
                <TableHead className="hidden md:table-cell">{ts.columns.schedule}</TableHead>
                <TableHead className="hidden lg:table-cell">{ts.columns.channels}</TableHead>
                <TableHead className="hidden md:table-cell">{ts.columns.nextRun}</TableHead>
                <TableHead>{ts.columns.enabled}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.map((subscription) => (
                <SubscriptionRow
                  key={subscription.id}
                  subscription={subscription}
                  targetName={names.get(subscription.targetId) ?? ts.missingTarget}
                  canChange={canUpdate && mayChange(subscription)}
                  canDelete={canDelete && mayChange(subscription)}
                  onEdit={() => setEditing(subscription)}
                  onDelete={() => setDeleting(subscription)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

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
    </div>
  );
}

export default function SubscriptionsPage() {
  const { t } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const canCreate = useCan('panel_reports:create');
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsPage
      title={ts.title}
      description={ts.description}
      actions={
        canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {ts.newSubscription}
          </Button>
        ) : undefined
      }
    >
      {(project) => <SubscriptionsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}
    </AnalyticsPage>
  );
}

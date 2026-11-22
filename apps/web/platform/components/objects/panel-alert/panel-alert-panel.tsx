/**
 * WeldPanel alert object panel: the record view of one alert, built like the
 * WeldPanel group and person panels: the `EntityDetailView` shell from
 * `useObjectPanelShell`, an icon + name header with the "⋮" menu of the
 * alert's actions, the icon tab strip, and tabs of property rows and standard
 * list rows.
 *
 * Tabs: Details (state, what it watches and how, last and next check, where it
 * sends) · History (fired, back to normal, failed checks).
 *
 * The Alerts list opens it; so do the links in alert emails and notifications
 * (`/weldpanel/alerts?alert=<id>`, which the list turns into this panel).
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  AlarmClockOff,
  Bell,
  BellRing,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  EllipsisVertical,
  Eye,
  Hash,
  Send,
  SlidersHorizontal,
  Timer,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_ALERT_EVENT_KINDS, type PanelAlertDto, type PanelAlertEventDto, type PanelAlertEventKind } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import type { ActiveFilter, FilterConfig } from '@/components/panel-entity-list';
import { PanelRow, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { ActivityIllustration, TAB_EMPTY_STATE_TABLE_CLASS, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useDeleteWeldPanelAlert, useWeldPanelAlert, useWeldPanelAlertEvents } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { AlertFormDialog } from '@/app/weldpanel/alerts/alert-form-dialog';
import { AlertMenuItems } from '@/app/weldpanel/alerts/alert-menu';
import { AlertStateBadge, useConditionText, useWatchText } from '@/app/weldpanel/alerts/alert-text';
import { ChannelsSummary } from '@/app/weldpanel/components/delivery-channels-fields';
import { useMembers } from '@/app/weldpanel/components/use-members';
import { isNotFoundError } from '@/app/weldpanel/lib/api-errors';
import { formatDateTime, formatNumber } from '@/app/weldpanel/lib/format';
import { reportBuilderHref } from '@/app/weldpanel/lib/links';
import { PANEL_ALERT_TAB_ICONS, isPanelAlertTabId, type PanelAlertTabId } from './panel-alert-tabs';

const PANEL_ALERT_WIDTH = 400;

const EVENT_ICONS: Record<PanelAlertEventKind, typeof BellRing> = { fired: BellRing, resolved: CheckCircle2, error: CircleAlert };
const EVENT_COLORS: Record<PanelAlertEventKind, string> = {
  fired: 'text-destructive',
  resolved: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-amber-600 dark:text-amber-400',
};

const isSnoozed = (alert: PanelAlertDto) => alert.snoozedUntil !== null && Date.parse(alert.snoozedUntil) > Date.now();

// ─── Header ────────────────────────────────────────────────────────────────

function AlertPanelIcon() {
  return (
    <div className="flex size-[22px] items-center justify-center rounded-[32%] bg-muted">
      <Bell className="size-3.5 text-muted-foreground" aria-hidden />
    </div>
  );
}

function AlertPanelTitle({ name }: Readonly<{ name?: string }>) {
  if (!name) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return <span className="block truncate text-[15px] font-medium leading-6 text-foreground">{name}</span>;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function DetailsTab({ alert }: Readonly<{ alert: PanelAlertDto }>) {
  const { t, language, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const td = ta.detail;
  const conditionText = useConditionText();
  const watchText = useWatchText();
  const { data: reports } = useWeldPanelReports({ projectId: alert.projectId }, alert.reportId !== null);
  const reportsById = useMemo(() => new Map((reports ?? []).map((r) => [r.id, r])), [reports]);
  const report = alert.reportId ? reportsById.get(alert.reportId) : undefined;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, language) : td.never);

  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1">
        <PanelRow icon={Activity} label={ta.columns.state} value={alert.state} renderValue={() => <AlertStateBadge alert={alert} />} />
        {isSnoozed(alert) && (
          <PanelRow icon={AlarmClockOff} label={ta.actions.snooze} value={format(ta.snoozed, { date: formatDateTime(alert.snoozedUntil!, language) })} />
        )}
        <PanelRow icon={Eye} label={td.watching} value={watchText(alert, reportsById)} />
        <PanelRow icon={SlidersHorizontal} label={td.condition} value={`${conditionText(alert.condition)} · ${ta.intervals[alert.checkInterval]}`} />
        <PanelRow icon={Hash} label={td.lastValue} value={alert.lastValue === null ? null : formatNumber(alert.lastValue, language)} tabular />
        <PanelRow icon={CalendarClock} label={td.lastChecked} value={when(alert.lastCheckedAt)} tabular />
        <PanelRow icon={BellRing} label={td.lastFired} value={when(alert.lastFiredAt)} tabular />
        <PanelRow icon={Timer} label={td.nextCheck} value={when(alert.nextCheckAt)} tabular />
        <PanelRow icon={Send} label={td.channels} value="channels" renderValue={() => <ChannelsSummary channels={alert.channels} />} />
      </div>
      {alert.lastError && (
        <p className="text-sm text-destructive" role="status">
          {td.lastError}: {alert.lastError}
        </p>
      )}
      {report && (
        <Button asChild variant="outline" size="sm">
          <Link href={reportBuilderHref(report.kind, report.id)}>{td.openReport}</Link>
        </Button>
      )}
    </div>
  );
}

type EventRow = PanelAlertEventDto;

/** Whether an event passes one complete Event pill (`is` / `is not`); an unfinished pill lets everything through. */
export function matchesEventFilter(event: Pick<PanelAlertEventDto, 'kind'>, filter: ActiveFilter): boolean {
  if (!filter.value) return true;
  const hit = event.kind === filter.value;
  return filter.operator === 'is not' ? !hit : hit;
}

const EVENT_COLUMN = {
  event: 'min-w-0 flex-1',
  value: 'w-[150px] @max-[560px]:hidden',
  time: 'w-[150px] @max-[560px]:w-[120px]',
};

function HistoryTab({ alertId }: Readonly<{ alertId: string }>) {
  const { t, language, format } = useI18n();
  const td = t.weldpanel.collab.alerts.detail;
  const { data: events, isLoading, isError, refetch } = useWeldPanelAlertEvents(alertId);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (events ?? []).filter(
      (event) =>
        activeFilters.every((filter) => matchesEventFilter(event, filter)) &&
        (needle === '' || td.events[event.kind].toLowerCase().includes(needle) || (event.message ?? '').toLowerCase().includes(needle)),
    );
  }, [events, activeFilters, search, td.events]);

  if (isLoading) return <Skeleton className="m-4 h-24" />;
  if (isError)
    return (
      <div className="p-4">
        <InlineError>
          {td.historyFailed}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
            {t.weldpanel.retry}
          </button>
        </InlineError>
      </div>
    );

  const filterConfigs: FilterConfig[] = [
    { field: 'kind', label: td.historyColumns.event, options: PANEL_ALERT_EVENT_KINDS.map((kind) => ({ value: kind, label: td.events[kind] })) },
  ];
  const headerColumns: HeaderColumn[] = [
    { id: 'event', header: td.historyColumns.event, width: EVENT_COLUMN.event },
    { id: 'value', header: td.historyColumns.value, width: EVENT_COLUMN.value },
    { id: 'time', header: td.historyColumns.time, width: EVENT_COLUMN.time },
  ];
  return (
    <TabListScope>
      <EntityList<EventRow>
        items={shown}
        isLoading={false}
        error={null}
        filters={filterConfigs}
        maxFilters={1}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={td.historySearch}
        // The list shows its desktop search box only with `searchFields`; the matching is done above.
        searchFields={['message']}
        headerColumns={headerColumns}
        renderRow={(event) => {
          const Icon = EVENT_ICONS[event.kind];
          return (
            <TabListRow key={event.id} label={td.events[event.kind]}>
              <div className={cn(EVENT_COLUMN.event, 'flex items-start gap-2')}>
                <Icon className={cn('mt-0.5 size-4 shrink-0', EVENT_COLORS[event.kind])} aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{td.events[event.kind]}</p>
                  {event.message && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{event.message}</p>}
                </div>
              </div>
              <div className={cn(EVENT_COLUMN.value, 'truncate text-sm tabular-nums text-muted-foreground')}>
                {event.value !== null && event.bound !== null
                  ? format(td.valueBound, { value: formatNumber(event.value, language), bound: formatNumber(event.bound, language) })
                  : '—'}
              </div>
              <div className={cn(EVENT_COLUMN.time, 'whitespace-nowrap text-sm tabular-nums text-muted-foreground')}>{formatDateTime(event.createdAt, language)}</div>
            </TabListRow>
          );
        }}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: td.historyTitle, description: td.historyEmpty }}
        noResultsState={{ title: td.historyNoMatch, description: '' }}
      />
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PanelAlertPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const ta = t.weldpanel.collab.alerts;
  const tc = t.weldpanel.analytics.common;
  const { id, onClose, initialTab } = props;

  const query = useWeldPanelAlert(id);
  const alert = query.data;
  const remove = useDeleteWeldPanelAlert();
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const canManage = useCan('panel_projects:manage');
  const { me } = useMembers();
  const mayChange = alert !== undefined && (alert.ownerUserId === me || canManage);

  const shell = useObjectPanelShell({ ...props, width: PANEL_ALERT_WIDTH, loading: query.isLoading && !alert });
  const mode = shell.mode;

  const [activeTab, setActiveTab] = useState<PanelAlertTabId>(() => (isPanelAlertTabId(initialTab) ? initialTab : 'overview'));
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tabs = useMemo(
    () =>
      (['overview', 'history'] as const).map((tabId) => ({
        id: tabId,
        label: tabId === 'overview' ? st('sweep.entities.detailsTab') : ta.detail.historyTitle,
        icon: PANEL_ALERT_TAB_ICONS[tabId],
      })),
    [st, ta.detail],
  );

  async function handleDelete() {
    if (!alert) return;
    try {
      await remove.mutateAsync(alert.id);
      toast.success(ta.deleted);
      setConfirmDelete(false);
      onClose();
    } catch {
      toast.error(ta.deleteFailed);
    }
  }

  const showMenu = alert !== undefined && ((canUpdate && mayChange) || (canDelete && mayChange));

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(mode)}
      avatar={<AlertPanelIcon />}
      title={<AlertPanelTitle name={alert?.name} />}
      actions={
        showMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
                aria-label={format(ta.actions.menu, { name: alert.name })}
              >
                <EllipsisVertical className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AlertMenuItems
                alert={alert}
                canChange={canUpdate && mayChange}
                canDelete={canDelete && mayChange}
                onEdit={() => setEditing(true)}
                onDelete={() => setConfirmDelete(true)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId as PanelAlertTabId)} />}
    >
      {!alert && query.isError && (
        <RecordLoadFailed
          notFound={isNotFoundError(query.error)}
          message={isNotFoundError(query.error) ? ta.notFound : ta.loadFailed}
          retryLabel={t.weldpanel.retry}
          onRetry={() => void query.refetch()}
        />
      )}

      {alert && activeTab === 'overview' && <DetailsTab alert={alert} />}
      {alert && activeTab === 'history' && <HistoryTab alertId={alert.id} />}

      {alert && (
        <>
          <AlertFormDialog open={editing} onOpenChange={setEditing} projectId={alert.projectId} alert={alert} />
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={format(ta.deleteTitle, { name: alert.name })}
            description={ta.deleteDescription}
            confirmLabel={tc.delete}
            cancelLabel={tc.cancel}
            variant="destructive"
            loading={remove.isPending}
            onConfirm={handleDelete}
          />
        </>
      )}
    </EntityDetailView>
  );
}

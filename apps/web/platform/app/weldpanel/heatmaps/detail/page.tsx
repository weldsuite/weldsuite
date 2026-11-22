/**
 * One page group's heatmap, opened from the heatmaps list, in the recording
 * page's shell: the standard title row on top (back to the list, the group's
 * name and pattern, a menu to edit or delete it), the toolbar row under it
 * (Filter for device and type, the period), the page
 * with its heat layer under it, and on the right a 400px column with the
 * elements ranked by clicks, the scroll depth and the group's info and
 * figures (`heatmap-sidebar.tsx`). The heat layer draws clicks, click areas or scroll
 * depth on a snapshot of the page; the numbers work without one, and the
 * background is asked for from the next visitor when no recording covers it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import {
  PANEL_DEVICE_CLASSES,
  PANEL_HEATMAP_TYPES,
  type PanelDeviceClass,
  type PanelHeatmapResult,
  type PanelHeatmapSpec,
  type PanelHeatmapType,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelHeatmapPageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { RecordingHeader, RecordingLayout } from '@weldsuite/ui/components/recording-layout';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  useDeleteWeldPanelHeatmapPage,
  useUpdateWeldPanelHeatmapPage,
  useWeldPanelHeatmap,
  useWeldPanelHeatmapPages,
  useWeldPanelHeatmapSnapshotLoader,
  weldpanelKeys,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useRouter } from '@/lib/router';
import { AnalyticsPage } from '../../components/analytics-page';
import { DateRangePicker } from '../../components/date-range-picker';
import { browserTimezone, useDateRange } from '../../lib/date-range';
import { readSnapshot } from '../../lib/heatmap';
import { snapshotFailure, type SnapshotFailure } from '../../lib/api-errors';
import type { ReplayEvent } from '../../lib/replay';
import { PageGroupDialog } from '../page-group-dialog';
import { SnapshotView } from '../snapshot-view';
import { HeatmapSidebar } from './heatmap-sidebar';

const LIST_HREF = '/weldpanel/heatmaps';

/** Device and type start as pills, so the filter shows what the heatmap is drawn for. */
const INITIAL_FILTERS: ActiveFilter[] = [
  { id: 'device', field: 'device', operator: 'is', value: 'desktop' },
  { id: 'type', field: 'type', operator: 'is', value: 'click' },
];

/** The value of a field's last pill when it is one of `allowed`; else `fallback` (a removed or empty pill). */
function pillValue<T extends string>(filters: readonly ActiveFilter[], field: string, allowed: readonly T[], fallback: T): T {
  const value = filters.findLast((filter) => filter.field === field && filter.value !== '')?.value;
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** One pill per field: a new pill for a field replaces the one before it. */
function onePerField(filters: readonly ActiveFilter[]): ActiveFilter[] {
  return filters.filter((filter, index) => !filters.slice(index + 1).some((later) => later.field === filter.field));
}

function interactionCount(result: PanelHeatmapResult, type: PanelHeatmapType): number {
  return type === 'scroll' ? result.scroll.leaves : result.clicks;
}

interface SnapshotLayerProps {
  result: PanelHeatmapResult;
  canSnapshot: boolean;
  snapshot: { isLoading: boolean; data: ReplayEvent | undefined };
  broken: boolean;
  failure: SnapshotFailure | null;
  deviceClass: PanelDeviceClass;
  onUnresolved: (count: number) => void;
  onBroken: () => void;
}

/** The page with its heat layer, alone on the page; a notice in its place when there is no snapshot to draw on. */
function SnapshotLayer({ result, canSnapshot, snapshot, broken, failure, deviceClass, onUnresolved, onBroken }: Readonly<SnapshotLayerProps>) {
  const { t } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  return (
    <div className="grid gap-3">
      {!canSnapshot && <InfoBanner variant="neutral">{t.weldpanel.observe.common.noPermission}</InfoBanner>}
      {canSnapshot && snapshot.isLoading && <Skeleton className="h-96 w-full" aria-label={th.snapshotLoading} />}
      {snapshot.data && !broken && (
        <SnapshotView snapshot={snapshot.data} deviceClass={deviceClass} heatmap={result} onUnresolved={onUnresolved} onBroken={onBroken} />
      )}
      {broken && <InfoBanner variant="danger">{th.snapshotBroken}</InfoBanner>}
      {failure === 'requested' && (
        <EmptyState icon={Camera} title={th.snapshotRequestedTitle} description={th.snapshotRequestedDescription} />
      )}
      {failure === 'unavailable' && (
        <EmptyState icon={Camera} title={th.snapshotUnavailableTitle} description={th.snapshotUnavailableDescription} />
      )}
      {failure === 'failed' && <InfoBanner variant="danger">{th.snapshotFailed}</InfoBanner>}
    </div>
  );
}

function Heatmap({ project, group }: Readonly<{ project: PanelProjectDto; group: PanelHeatmapPageDto }>) {
  const { t, format } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const router = useRouter();
  const canEdit = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  // The snapshot is a recording's page, so it takes the recordings permission.
  const canSnapshot = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [filters, setFilters] = useState<ActiveFilter[]>(INITIAL_FILTERS);
  const deviceClass = pillValue<PanelDeviceClass>(filters, 'device', PANEL_DEVICE_CLASSES, 'desktop');
  const type = pillValue<PanelHeatmapType>(filters, 'type', PANEL_HEATMAP_TYPES, 'click');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unresolved, setUnresolved] = useState(0);
  const [broken, setBroken] = useState(false);
  const update = useUpdateWeldPanelHeatmapPage(project.id);
  const remove = useDeleteWeldPanelHeatmapPage(project.id);

  const spec = useMemo<PanelHeatmapSpec>(
    () => ({ kind: 'heatmap', projectId: project.id, dateRange: range, timezone: browserTimezone(), type, deviceClass, pageGroupId: group.id }),
    [project.id, range, type, deviceClass, group.id],
  );
  const { data, error, isLoading, refetch } = useWeldPanelHeatmap(spec);
  const result = data?.result;

  const loadSnapshot = useWeldPanelHeatmapSnapshotLoader();
  const snapshot = useQuery({
    queryKey: [...weldpanelKeys.all, 'heatmap-snapshot', group.id, deviceClass],
    queryFn: async () => readSnapshot(await (await loadSnapshot(group.id, deviceClass)).arrayBuffer()),
    enabled: canSnapshot,
    retry: false,
    staleTime: 5 * 60_000,
    meta: { persist: false },
  });

  useEffect(() => {
    setBroken(false);
    setUnresolved(0);
  }, [group.id, deviceClass]);

  const noData = result && interactionCount(result, type) === 0;
  const failure = snapshot.error ? snapshotFailure(snapshot.error) : null;
  const filterConfigs: FilterConfig[] = [
    {
      field: 'device',
      label: th.device,
      operators: ['is'],
      options: PANEL_DEVICE_CLASSES.map((device) => ({ value: device, label: t.weldpanel.observe.common.devices[device] })),
    },
    { field: 'type', label: th.type, operators: ['is'], options: PANEL_HEATMAP_TYPES.map((value) => ({ value, label: th.types[value] })) },
  ];

  const menu = (canEdit || canDelete) && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-[30px] text-muted-foreground" aria-label={t.common.actions.title}>
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canEdit && (
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            {th.editPageGroup}
          </DropdownMenuItem>
        )}
        {canEdit && canDelete && <DropdownMenuSeparator />}
        {canDelete && (
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 />
            {th.deletePageGroup}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // The standard title row (back, the page group's name and pattern, its menu), then the filter row.
  const header = (
    <>
      <RecordingHeader
        onBack={() => router.push(LIST_HREF)}
        backLabel={th.back}
        title={group.name}
        subtitle={<span className="font-mono text-xs">{group.urlPattern}</span>}
        actions={menu}
      />
      <ListToolbar
        filterSlot={
          <FilterPills
            filters={filters}
            filterConfigs={filterConfigs}
            maxFilters={filterConfigs.length}
            onFiltersChange={(next) => setFilters(onePerField(next))}
            labels={{ filter: t.common.actions.filter }}
          />
        }
        actionButtons={<DateRangePicker value={range} onChange={setRange} />}
      />
    </>
  );

  return (
    <RecordingLayout header={header} sidebar={<HeatmapSidebar group={group} spec={spec} result={result} unresolved={unresolved} aiEnabled={project.settings.aiEnabled} />}>
      <div className="space-y-6">

      {/* The page alone: no card, no title or notes around it. */}
      {isLoading && <Skeleton className="h-96 w-full" aria-label={th.snapshotLoading} />}
      {!isLoading && error && <ErrorState message={th.dataLoadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}
      {result && noData && <p className="text-sm text-muted-foreground">{th.noData}</p>}
      {result && !noData && (
        <SnapshotLayer
          result={result}
          canSnapshot={canSnapshot}
          snapshot={snapshot}
          broken={broken}
          failure={failure}
          deviceClass={deviceClass}
          onUnresolved={setUnresolved}
          onBroken={() => setBroken(true)}
        />
      )}

      </div>

      <PageGroupDialog
        open={editing}
        onOpenChange={setEditing}
        initial={{ name: group.name, urlPattern: group.urlPattern }}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ id: group.id, ...values });
            toast.success(th.saved);
          } catch (err) {
            toast.error(th.saveFailed);
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={format(th.deleteConfirmTitle, { name: group.name })}
        description={th.deleteConfirmDescription}
        confirmLabel={th.deleteConfirm}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(group.id);
            toast.success(th.deleted);
            setConfirmDelete(false);
            router.push(LIST_HREF);
          } catch {
            toast.error(th.deleteFailed);
          }
        }}
      />
    </RecordingLayout>
  );
}

/** Finds the page group in the current project, then shows its heatmap, or says it is gone. */
function PageGroupHeatmap({ project, pageGroupId }: Readonly<{ project: PanelProjectDto; pageGroupId: string }>) {
  const { t } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const router = useRouter();
  const { data: groups, isLoading, isError, refetch } = useWeldPanelHeatmapPages(project.id);
  const group = groups?.find((g) => g.id === pageGroupId);

  useBreadcrumbs(
    [
      { label: t.weldpanel.breadcrumb.home, href: '/weldpanel' },
      { label: th.title, href: LIST_HREF },
      { label: group?.name ?? '…' },
    ],
    { enabled: !!group },
  );

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <div className="p-6"><ErrorState message={th.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} /></div>;
  if (!group) {
    return (
      <DetailPage>
        <DetailHeader title={th.title} onBack={() => router.push(LIST_HREF)} backLabel={th.back} />
        <ErrorState message={th.notFound} />
      </DetailPage>
    );
  }
  return <Heatmap project={project} group={group} />;
}

export default function HeatmapDetailPage() {
  const { t } = useI18n();
  const params = useParams<{ pageId: string }>();
  const pageGroupId = params.pageId ?? '';
  return (
    <AnalyticsPage title={t.weldpanel.observe.heatmaps.title} bare>
      {(project) => <PageGroupHeatmap key={`${project.id}:${pageGroupId}`} project={project} pageGroupId={pageGroupId} />}
    </AnalyticsPage>
  );
}

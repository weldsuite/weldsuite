/**
 * Heatmaps: pick a page group (a URL pattern), a device class, a type and a
 * period, and see clicks, click areas or scroll depth drawn on a snapshot of
 * the page. The numbers work without a snapshot; the background is asked for
 * from the next visitor when no recording covers the page.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, Flame, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import {
  PANEL_DEVICE_CLASSES,
  PANEL_HEATMAP_TYPES,
  type PanelDeviceClass,
  type PanelHeatmapSpec,
  type PanelHeatmapType,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelHeatmapPageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import {
  useCreateWeldPanelHeatmapPage,
  useDeleteWeldPanelHeatmapPage,
  useUpdateWeldPanelHeatmapPage,
  useWeldPanelHeatmap,
  useWeldPanelHeatmapPages,
  useWeldPanelHeatmapSnapshotLoader,
  weldpanelKeys,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { browserTimezone, useDateRange } from '../lib/date-range';
import { formatNumber, formatPercent } from '../lib/format';
import { averageFold, readSnapshot } from '../lib/heatmap';
import { snapshotFailure } from '../lib/api-errors';
import { PageGroupDialog } from './page-group-dialog';
import { SnapshotView } from './snapshot-view';

export default function HeatmapsPage() {
  const { t } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  return (
    <AnalyticsPage title={th.title} description={th.description}>
      {(project) => <Heatmaps key={project.id} project={project} />}
    </AnalyticsPage>
  );
}

function Heatmaps({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language, format } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const canEdit = useCan('panel_reports:update');
  const canCreate = useCan('panel_reports:create');
  const canDelete = useCan('panel_reports:delete');
  // The snapshot is a recording's page, so it takes the recordings permission.
  const canSnapshot = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [deviceClass, setDeviceClass] = useState<PanelDeviceClass>('desktop');
  const [type, setType] = useState<PanelHeatmapType>('click');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unresolved, setUnresolved] = useState(0);
  const [broken, setBroken] = useState(false);

  const { data: groups, isLoading: groupsLoading } = useWeldPanelHeatmapPages(project.id);
  const create = useCreateWeldPanelHeatmapPage();
  const update = useUpdateWeldPanelHeatmapPage(project.id);
  const remove = useDeleteWeldPanelHeatmapPage(project.id);

  // The first group is chosen until the user picks one; a deleted group falls back to the first.
  const group: PanelHeatmapPageDto | undefined = groups?.find((g) => g.id === groupId) ?? groups?.[0];

  const spec = useMemo<PanelHeatmapSpec>(
    () => ({ kind: 'heatmap', projectId: project.id, dateRange: range, timezone: browserTimezone(), type, deviceClass, pageGroupId: group?.id ?? '' }),
    [project.id, range, type, deviceClass, group?.id],
  );
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelHeatmap(spec, { enabled: !!group });
  const result = data?.result;

  const loadSnapshot = useWeldPanelHeatmapSnapshotLoader();
  const snapshot = useQuery({
    queryKey: [...weldpanelKeys.all, 'heatmap-snapshot', group?.id ?? '', deviceClass],
    queryFn: async () => readSnapshot(await (await loadSnapshot(group!.id, deviceClass)).arrayBuffer()),
    enabled: !!group && canSnapshot,
    retry: false,
    staleTime: 5 * 60_000,
    meta: { persist: false },
  });

  useEffect(() => {
    setBroken(false);
    setUnresolved(0);
  }, [group?.id, deviceClass]);

  if (groupsLoading) return <Skeleton className="h-64 w-full" />;

  if (!groups || groups.length === 0) {
    return (
      <>
        <EmptyState
          icon={Flame}
          title={th.noGroupsTitle}
          description={th.noGroupsDescription}
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setDialog('create')}>
                <Plus />
                {th.newPageGroup}
              </Button>
            ) : undefined
          }
        />
        <PageGroupDialog
          open={dialog === 'create'}
          onOpenChange={(open) => !open && setDialog(null)}
          onSubmit={async (values) => {
            try {
              const created = await create.mutateAsync({ projectId: project.id, ...values });
              setGroupId(created.id);
              toast.success(th.saved);
            } catch (err) {
              toast.error(th.saveFailed);
              throw err;
            }
          }}
        />
      </>
    );
  }

  const fold = result && type === 'scroll' ? averageFold(result.scroll.buckets) : null;
  const noData = result && (type === 'scroll' ? result.scroll.leaves === 0 : result.clicks === 0);
  const failure = snapshot.error ? snapshotFailure(snapshot.error) : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <LabeledField label={th.pageGroup} htmlFor="weldpanel-heatmap-group">
          <Select value={group?.id} onValueChange={setGroupId}>
            <SelectTrigger id="weldpanel-heatmap-group" size="sm" className="h-8 w-56">
              <SelectValue placeholder={th.choosePageGroup} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledField>
        <div className="flex gap-1 pb-0.5">
          {canCreate && (
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog('create')}>
              <Plus />
              {th.newPageGroup}
            </Button>
          )}
          {canEdit && group && (
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={th.editPageGroup} onClick={() => setDialog('edit')}>
              <Pencil />
            </Button>
          )}
          {canDelete && group && (
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={th.deletePageGroup} onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          )}
        </div>
        <LabeledField label={th.device}>
          <ToggleGroup type="single" variant="outline" size="sm" value={deviceClass} onValueChange={(v) => v && setDeviceClass(v as PanelDeviceClass)} aria-label={th.device}>
            {PANEL_DEVICE_CLASSES.map((device) => (
              <ToggleGroupItem key={device} value={device}>
                {t.weldpanel.observe.common.devices[device]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </LabeledField>
        <LabeledField label={th.type} hint={th.typeHints[type]}>
          <ToggleGroup type="single" variant="outline" size="sm" value={type} onValueChange={(v) => v && setType(v as PanelHeatmapType)} aria-label={th.type}>
            {PANEL_HEATMAP_TYPES.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {th.types[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </LabeledField>
        <div className="ml-auto pb-0.5">
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {group && <p className="font-mono text-xs text-muted-foreground">{format(th.pageHint, { pattern: group.urlPattern })}</p>}

      <KpiGrid className="sm:grid-cols-3">
        <KpiCard label={th.stats.pageviews} loading={isLoading || !result} value={result ? formatNumber(result.pageviews, language) : ''} />
        <KpiCard label={type === 'scroll' ? th.stats.leaves : th.stats.clicks} loading={isLoading || !result} value={result ? formatNumber(type === 'scroll' ? result.scroll.leaves : result.clicks, language) : ''} />
        <KpiCard label={th.stats.unresolved} loading={isLoading || !result} value={formatNumber(unresolved, language)} tone={unresolved > 0 ? 'warning' : 'default'} />
      </KpiGrid>

      <ChartCard title={th.layer} loading={isLoading && !!group} error={error} onRetry={() => void refetch()} empty={!!noData} emptyText={th.noData} skeletonClassName="h-96" actions={data && <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />}>
        {result && (
          <div className="grid gap-3">
            {type === 'scroll' && (
              <p className="text-sm text-muted-foreground">{fold === null ? th.scrollAll : format(th.scrollSummary, { depth: fold })}</p>
            )}
            {!canSnapshot && <InfoBanner variant="neutral">{t.weldpanel.observe.common.noPermission}</InfoBanner>}
            {canSnapshot && snapshot.isLoading && <Skeleton className="h-96 w-full" aria-label={th.snapshotLoading} />}
            {snapshot.data && !broken && (
              <SnapshotView snapshot={snapshot.data} deviceClass={deviceClass} heatmap={result} onUnresolved={setUnresolved} onBroken={() => setBroken(true)} />
            )}
            {broken && <InfoBanner variant="danger">{th.snapshotBroken}</InfoBanner>}
            {failure === 'requested' && (
              <EmptyState icon={Camera} title={th.snapshotRequestedTitle} description={th.snapshotRequestedDescription} />
            )}
            {failure === 'unavailable' && (
              <EmptyState icon={Camera} title={th.snapshotUnavailableTitle} description={th.snapshotUnavailableDescription} />
            )}
            {failure === 'failed' && <InfoBanner variant="danger">{th.snapshotFailed}</InfoBanner>}
            {unresolved > 0 && <p className="text-xs text-muted-foreground">{format(th.unresolvedHint, { count: unresolved })}</p>}
          </div>
        )}
      </ChartCard>

      {result && type !== 'scroll' && (
        <ChartCard title={th.topElements} empty={result.elements.length === 0} emptyText={th.noElements}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{th.elementCol}</TableHead>
                  <TableHead className="text-right">{th.clicksCol}</TableHead>
                  <TableHead className="text-right">{th.shareCol}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.elements.slice(0, 15).map((element) => (
                  <TableRow key={element.selector}>
                    <TableCell className="max-w-96">
                      <p className="truncate text-sm font-medium">{element.text || element.selector}</p>
                      {element.text && <p className="truncate font-mono text-xs text-muted-foreground">{element.selector}</p>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(element.clicks, language)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPercent(element.share, language)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ChartCard>
      )}

      <PageGroupDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        initial={dialog === 'edit' && group ? { name: group.name, urlPattern: group.urlPattern } : undefined}
        onSubmit={async (values) => {
          try {
            if (dialog === 'edit' && group) await update.mutateAsync({ id: group.id, ...values });
            else setGroupId((await create.mutateAsync({ projectId: project.id, ...values })).id);
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
        title={format(th.deleteConfirmTitle, { name: group?.name ?? '' })}
        description={th.deleteConfirmDescription}
        confirmLabel={th.deleteConfirm}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!group) return;
          try {
            await remove.mutateAsync(group.id);
            setGroupId(null);
            toast.success(th.deleted);
            setConfirmDelete(false);
          } catch {
            toast.error(th.deleteFailed);
          }
        }}
      />
    </div>
  );
}

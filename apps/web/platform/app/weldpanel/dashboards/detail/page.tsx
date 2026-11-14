import { useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Loader2, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelDashboardDetailDto, PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  useAddWeldPanelDashboardTile,
  useDeleteWeldPanelDashboard,
  useRemoveWeldPanelDashboardTile,
  useSetWeldPanelDashboardLayout,
  useUpdateWeldPanelDashboard,
  useWeldPanelDashboard,
  useWeldPanelReports,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useParams, useRouter } from '@/lib/router';
import { NEW_TILE_LAYOUT } from '../../components/report-actions';
import { NameDialog } from '../../components/name-dialog';
import { ReportView } from '../../components/report-view';
import { GRID_COLUMNS, ROW_UNIT_PX, moveItem, normalizeLayout, orderItems, packLayout, stepHeight, stepWidth } from '../../lib/dashboard-layout';
import { reportBuilderHref } from '../../lib/links';
import { useCurrentProject } from '../../lib/use-current-project';

type TileAction = 'earlier' | 'later' | 'wider' | 'narrower' | 'taller' | 'shorter' | 'remove';

interface TileCardProps {
  name: string;
  report: PanelReportDto | undefined;
  style: React.CSSProperties;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onAction: (action: TileAction) => void;
}

function TileCard({ name, report, style, canEdit, first, last, onAction }: Readonly<TileCardProps>) {
  const { t } = useI18n();
  const tt = t.weldpanel.analytics.dashboards.tile;
  return (
    <Card className="min-w-0 gap-2 overflow-hidden py-3 lg:[grid-column:var(--tile-col)]" style={style}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 px-4 pb-0">
        <CardTitle className="min-w-0 truncate text-sm font-medium">
          {report ? (
            <Link href={reportBuilderHref(report.kind, report.id)} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </CardTitle>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={tt.actions.replace('{name}', name)}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {report && (
              <DropdownMenuItem asChild>
                <Link href={reportBuilderHref(report.kind, report.id)}>{tt.openReport}</Link>
              </DropdownMenuItem>
            )}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={first} onSelect={() => onAction('earlier')}>
                  {tt.earlier}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onAction('later')}>
                  {tt.later}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('wider')}>{tt.wider}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('narrower')}>{tt.narrower}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('taller')}>{tt.taller}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('shorter')}>{tt.shorter}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onAction('remove')}>
                  {tt.remove}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto px-4">
        {report ? <ReportView report={report} /> : <p className="text-sm text-muted-foreground">{tt.missing}</p>}
      </CardContent>
    </Card>
  );
}

function AddReportDialog({ dashboard, open, onOpenChange }: Readonly<{ dashboard: PanelDashboardDetailDto; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const tc = t.weldpanel.analytics.common;
  const [reportId, setReportId] = useState('');
  const { data: reports } = useWeldPanelReports({ projectId: dashboard.projectId }, open);
  const add = useAddWeldPanelDashboardTile(dashboard.id);
  const used = new Set(dashboard.tiles.map((tile) => tile.reportId));
  const available = (reports ?? []).filter((r) => !used.has(r.id));

  async function submit() {
    try {
      await add.mutateAsync({ reportId, layout: NEW_TILE_LAYOUT });
      toast.success(td.added);
      setReportId('');
      onOpenChange(false);
    } catch {
      toast.error(td.addFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (add.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{td.addTitle}</DialogTitle>
          <DialogDescription>{td.addDescription}</DialogDescription>
        </DialogHeader>
        {reports && available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {td.noReports}{' '}
            <Link href="/weldpanel/insights" className="underline underline-offset-2">
              {t.weldpanel.analytics.reports.newKinds.trends}
            </Link>
          </p>
        ) : (
          <Select value={reportId} onValueChange={setReportId}>
            <SelectTrigger aria-label={td.addTitle}>
              <SelectValue placeholder={td.addPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {available.map((report) => (
                <SelectItem key={report.id} value={report.id}>
                  {report.name} · {t.weldpanel.analytics.kinds[report.kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={add.isPending} onClick={() => onOpenChange(false)}>
            {tc.cancel}
          </Button>
          <Button type="button" disabled={reportId === '' || add.isPending} onClick={() => void submit()}>
            {add.isPending && <Loader2 className="animate-spin" />}
            {tc.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DashboardView({ dashboard }: Readonly<{ dashboard: PanelDashboardDetailDto }>) {
  const { t } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateWeldPanelDashboard(dashboard.id);
  const remove = useDeleteWeldPanelDashboard();
  const removeTile = useRemoveWeldPanelDashboardTile(dashboard.id);
  const setLayout = useSetWeldPanelDashboardLayout(dashboard.id);

  const reportsById = useMemo(() => new Map(dashboard.reports.map((r) => [r.id, r])), [dashboard.reports]);
  const packed = useMemo(() => normalizeLayout(dashboard.tiles), [dashboard.tiles]);
  const layoutById = new Map(packed.map((item) => [item.id, item.layout]));
  const ordered = orderItems(dashboard.tiles.map((tile) => ({ ...tile, layout: layoutById.get(tile.id) ?? tile.layout })));

  async function save(items: { id: string; w: number; h: number }[]) {
    try {
      await setLayout.mutateAsync({ tiles: packLayout(items) });
    } catch {
      toast.error(td.layoutFailed);
    }
  }

  async function act(index: number, action: TileAction) {
    const tile = ordered[index];
    if (!tile) return;
    if (action === 'remove') {
      try {
        await removeTile.mutateAsync(tile.id);
        toast.success(td.removed);
      } catch {
        toast.error(td.removeFailed);
      }
      return;
    }
    const items = ordered.map((item) => ({ id: item.id, w: item.layout.w, h: item.layout.h }));
    const target = items[index]!;
    if (action === 'earlier' || action === 'later') return void save(moveItem(items, index, action === 'earlier' ? -1 : 1));
    if (action === 'wider' || action === 'narrower') target.w = stepWidth(target.w, action === 'wider' ? 1 : -1);
    else target.h = stepHeight(target.h, action === 'taller' ? 1 : -1);
    void save(items);
  }

  return (
    <DetailPage>
      <DetailHeader
        title={dashboard.name}
        subtitle={dashboard.description ?? td.tileCount.replace('{count}', String(dashboard.tiles.length))}
        badges={<SoftBadge tone={dashboard.visibility === 'workspace' ? 'success' : 'neutral'}>{dashboard.visibility === 'workspace' ? tc.workspace : tc.private}</SoftBadge>}
        onBack={() => router.push('/weldpanel/dashboards')}
        backLabel={td.back}
        actions={
          <>
            {canUpdate && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus />
                {td.addReport}
              </Button>
            )}
            {(canUpdate || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" className="size-8" aria-label={tc.edit}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canUpdate && <DropdownMenuItem onSelect={() => setRenaming(true)}>{tc.rename}</DropdownMenuItem>}
                  {canDelete && (
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(true)}>
                      {tc.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {ordered.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title={td.emptyDashboardTitle}
          description={td.emptyDashboardDescription}
          action={
            canUpdate ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus />
                {td.addReport}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(24,minmax(0,1fr))]" data-testid="weldpanel-dashboard-grid" data-columns={GRID_COLUMNS}>
            {ordered.map((tile, index) => {
              const report = reportsById.get(tile.reportId);
              return (
                <TileCard
                  key={tile.id}
                  name={report?.name ?? tile.reportId}
                  report={report}
                  canEdit={canUpdate}
                  first={index === 0}
                  last={index === ordered.length - 1}
                  style={{ '--tile-col': `span ${tile.layout.w}`, minHeight: tile.layout.h * ROW_UNIT_PX } as React.CSSProperties}
                  onAction={(action) => void act(index, action)}
                />
              );
            })}
        </div>
      )}

      <AddReportDialog dashboard={dashboard} open={adding} onOpenChange={setAdding} />
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={td.renameTitle}
        submitLabel={tc.save}
        initial={{ name: dashboard.name }}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ name: values.name });
            toast.success(td.renamed);
            setRenaming(false);
          } catch {
            toast.error(td.renameFailed);
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={td.deleteTitle.replace('{name}', dashboard.name)}
        description={td.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(dashboard.id);
            toast.success(td.deleted);
            router.push('/weldpanel/dashboards');
          } catch {
            toast.error(td.deleteFailed);
          }
        }}
      />
    </DetailPage>
  );
}

export default function DashboardDetailPage() {
  const { t } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const params = useParams<{ dashboardId: string }>();
  const dashboardId = params.dashboardId ?? '';
  const { data: dashboard, isLoading, isError, error, refetch } = useWeldPanelDashboard(dashboardId);
  const { select } = useCurrentProject();
  const projectId = dashboard?.projectId;

  // A link to a dashboard of another project switches to that project, so the header and pickers agree.
  useEffect(() => {
    if (projectId) select(projectId);
    // `select` only sets state; run once per dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError || !dashboard) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <div className="p-6">
        <ErrorState message={notFound ? td.notFound : t.weldpanel.analytics.errors.loadFailed} onRetry={notFound ? undefined : () => void refetch()} retryLabel={t.weldpanel.retry} />
      </div>
    );
  }
  return <DashboardView dashboard={dashboard} />;
}

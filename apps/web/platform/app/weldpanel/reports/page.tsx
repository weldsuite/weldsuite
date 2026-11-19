import { lazy, Suspense, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { BarChart3, ChevronDown, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_REPORT_SPEC_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useDeleteWeldPanelReport, useUpdateWeldPanelReport, useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { NameDialog } from '../components/name-dialog';
import { formatDate } from '../lib/format';
import { reportBuilderHref } from '../lib/links';

type Scope = 'all' | 'mine' | 'shared';

// Loaded when opened.
const ShareDialog = lazy(() => import('../components/share-dialog').then((m) => ({ default: m.ShareDialog })));

/** The row menu's items. Report actions need their own mutation hook (a hook per id), so this is a component. */
function ReportMenuItems({ report, onRename, onDelete, onShare }: Readonly<{ report: PanelReportDto; onRename: () => void; onDelete: () => void; onShare: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.reports;
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const update = useUpdateWeldPanelReport(report.id);
  const next = report.visibility === 'private' ? 'workspace' : 'private';

  async function toggleVisibility() {
    try {
      await update.mutateAsync({ visibility: next });
      toast.success(tr.visibilityChanged);
    } catch {
      toast.error(t.weldpanel.analytics.common.failed);
    }
  }

  return (
    <>
      <DropdownMenuItem asChild>
        <Link href={reportBuilderHref(report.kind, report.id)}>{t.weldpanel.analytics.common.open}</Link>
      </DropdownMenuItem>
      {canUpdate && <DropdownMenuItem onSelect={onRename}>{t.weldpanel.analytics.common.rename}</DropdownMenuItem>}
      {canUpdate && <DropdownMenuItem onSelect={() => void toggleVisibility()}>{next === 'private' ? tr.makePrivate : tr.makeShared}</DropdownMenuItem>}
      <DropdownMenuItem onSelect={onShare}>{t.weldpanel.collab.share.button}</DropdownMenuItem>
      {canDelete && <DropdownMenuSeparator />}
      {canDelete && (
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          {t.weldpanel.analytics.common.delete}
        </DropdownMenuItem>
      )}
    </>
  );
}

function RenameReportDialog({ report, onClose }: Readonly<{ report: PanelReportDto | null; onClose: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.reports;
  const update = useUpdateWeldPanelReport(report?.id ?? '');
  return (
    <NameDialog
      open={report !== null}
      onOpenChange={(open) => !open && onClose()}
      title={tr.renameTitle}
      submitLabel={t.weldpanel.analytics.common.save}
      initial={{ name: report?.name ?? '' }}
      onSubmit={async (values) => {
        try {
          await update.mutateAsync({ name: values.name });
          toast.success(tr.renamed);
          onClose();
        } catch {
          toast.error(tr.renameFailed);
        }
      }}
    />
  );
}

function ReportsList({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tr = t.weldpanel.analytics.reports;
  const tk = t.weldpanel.analytics.kinds;
  const tc = t.weldpanel.analytics.common;
  const { userId } = useAuth();
  const canCreate = useCan('panel_reports:create');
  const router = useRouter();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [renaming, setRenaming] = useState<PanelReportDto | null>(null);
  const [deleting, setDeleting] = useState<PanelReportDto | null>(null);
  const [sharing, setSharing] = useState<PanelReportDto | null>(null);
  const remove = useDeleteWeldPanelReport();
  // One value per picker: the API filters on a single scope and a single kind.
  const scope: Scope = (activeFilters.find((f) => f.field === 'scope' && f.value)?.value as Scope | undefined) ?? 'all';
  const kind = activeFilters.find((f) => f.field === 'kind' && f.value)?.value as PanelReportDto['kind'] | undefined;
  const params = useMemo(() => ({ projectId, scope, ...(kind ? { kind } : {}) }), [projectId, scope, kind]);
  const { data: reports, isLoading, isError, refetch } = useWeldPanelReports(params);

  const filters = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'scope',
        label: tr.scopeLabel,
        options: [
          { value: 'mine', label: tr.scopes.mine },
          { value: 'shared', label: tr.scopes.shared },
        ],
      },
      { field: 'kind', label: tr.kindLabel, options: PANEL_REPORT_SPEC_KINDS.filter((k) => k !== 'web').map((k) => ({ value: k, label: tk[k] })) },
    ],
    [tr, tk],
  );

  if (isError) return <ErrorState message={tr.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (isLoading && !reports) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  const columns: ColumnDef<PanelReportDto>[] = [
    {
      id: 'name',
      header: tr.columns.name,
      width: 'flex-1 min-w-[180px]',
      render: (report) => <span className="block truncate font-medium">{report.name}</span>,
    },
    {
      id: 'type',
      header: tr.columns.type,
      width: 'w-[120px]',
      render: (report) => <SoftBadge tone="neutral">{tk[report.kind]}</SoftBadge>,
    },
    {
      id: 'visibility',
      header: tr.columns.visibility,
      width: 'hidden sm:block sm:w-[120px]',
      render: (report) => <SoftBadge tone={report.visibility === 'workspace' ? 'success' : 'neutral'}>{report.visibility === 'workspace' ? tc.workspace : tc.private}</SoftBadge>,
    },
    {
      id: 'owner',
      header: tr.columns.owner,
      width: 'hidden md:block md:w-[120px]',
      render: (report) => <span className="text-muted-foreground">{report.ownerUserId === userId ? tc.ownedByYou : tc.shared}</span>,
    },
    {
      id: 'updated',
      header: tr.columns.updated,
      width: 'hidden md:block md:w-[120px]',
      render: (report) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(report.updatedAt, language)}</span>,
    },
  ];

  return (
    <>
      <PanelEntityList<PanelReportDto>
        items={reports ?? []}
        isLoading={false}
        columns={columns}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        actionButtons={
          canCreate ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus />
                  {tr.newReport}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(['trends', 'funnel', 'retention', 'flows'] as const).map((k) => (
                  <DropdownMenuItem key={k} asChild>
                    <Link href={reportBuilderHref(k)}>{tr.newKinds[k]}</Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
        rowMenu={(report) => <ReportMenuItems report={report} onRename={() => setRenaming(report)} onDelete={() => setDeleting(report)} onShare={() => setSharing(report)} />}
        onRowClick={(report) => router.push(reportBuilderHref(report.kind, report.id))}
        emptyState={{ icon: <BarChart3 className="size-8 text-muted-foreground" />, title: tr.emptyTitle, description: tr.emptyDescription }}
        noResultsState={{ icon: <BarChart3 className="size-8 text-muted-foreground" />, title: tr.noMatches, description: '' }}
      />

      <RenameReportDialog report={renaming} onClose={() => setRenaming(null)} />
      <Suspense fallback={null}>
        {sharing && (
          <ShareDialog
            open
            onOpenChange={(open) => !open && setSharing(null)}
            target={{ targetType: 'report', targetId: sharing.id, name: sharing.name, ownerUserId: sharing.ownerUserId, visibility: sharing.visibility }}
          />
        )}
      </Suspense>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tr.deleteTitle.replace('{name}', deleting?.name ?? '')}
        description={tr.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tr.deleted);
            setDeleting(null);
          } catch {
            toast.error(tr.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function ReportsPage() {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.reports;
  return <AnalyticsListPage title={tr.title}>{(project) => <ReportsList key={project.id} projectId={project.id} />}</AnalyticsListPage>;
}

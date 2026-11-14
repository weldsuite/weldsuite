import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { BarChart3, ChevronDown, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_REPORT_SPEC_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useDeleteWeldPanelReport, useUpdateWeldPanelReport, useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { NameDialog } from '../components/name-dialog';
import { formatDate } from '../lib/format';
import { reportBuilderHref } from '../lib/links';

type Scope = 'all' | 'mine' | 'shared';

/** Report actions need their own mutation hook (a hook per id), so each row's menu is a component. */
function RowMenu({ report, onRename, onDelete }: Readonly<{ report: PanelReportDto; onRename: () => void; onDelete: () => void }>) {
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={tr.actions.replace('{name}', report.name)}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={reportBuilderHref(report.kind, report.id)}>{t.weldpanel.analytics.common.open}</Link>
        </DropdownMenuItem>
        {canUpdate && <DropdownMenuItem onSelect={onRename}>{t.weldpanel.analytics.common.rename}</DropdownMenuItem>}
        {canUpdate && <DropdownMenuItem onSelect={() => void toggleVisibility()}>{next === 'private' ? tr.makePrivate : tr.makeShared}</DropdownMenuItem>}
        {canDelete && <DropdownMenuSeparator />}
        {canDelete && (
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
            {t.weldpanel.analytics.common.delete}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [scope, setScope] = useState<Scope>('all');
  const [kind, setKind] = useState<PanelReportDto['kind'] | undefined>(undefined);
  const [renaming, setRenaming] = useState<PanelReportDto | null>(null);
  const [deleting, setDeleting] = useState<PanelReportDto | null>(null);
  const remove = useDeleteWeldPanelReport();
  const params = useMemo(() => ({ projectId, scope, ...(kind ? { kind } : {}) }), [projectId, scope, kind]);
  const { data: reports, isLoading, isError, refetch } = useWeldPanelReports(params);

  if (isError) return <ErrorState message={tr.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const filtered = scope !== 'all' || kind !== undefined;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={scope === 'all' ? undefined : scope}
          onChange={(next) => setScope((next as Scope | undefined) ?? 'all')}
          allLabel={tr.scopes.all}
          ariaLabel={tr.scopeLabel}
          options={[
            { value: 'mine', label: tr.scopes.mine },
            { value: 'shared', label: tr.scopes.shared },
          ]}
        />
        <FilterSelect
          value={kind}
          onChange={(next) => setKind(next as PanelReportDto['kind'] | undefined)}
          allLabel={tr.allKinds}
          ariaLabel={tr.kindLabel}
          options={PANEL_REPORT_SPEC_KINDS.filter((k) => k !== 'web').map((k) => ({ value: k, label: tk[k] }))}
        />
      </div>

      {isLoading && (
        <div className="grid gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {!isLoading && (!reports || reports.length === 0) && (
        <EmptyState icon={BarChart3} title={filtered ? tr.noMatches : tr.emptyTitle} description={filtered ? undefined : tr.emptyDescription} />
      )}
      {!isLoading && reports && reports.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr.columns.name}</TableHead>
                <TableHead>{tr.columns.type}</TableHead>
                <TableHead className="hidden sm:table-cell">{tr.columns.visibility}</TableHead>
                <TableHead className="hidden md:table-cell">{tr.columns.owner}</TableHead>
                <TableHead className="hidden md:table-cell">{tr.columns.updated}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="max-w-72">
                    <Link href={reportBuilderHref(report.kind, report.id)} className="block truncate font-medium hover:underline">
                      {report.name}
                    </Link>
                    {report.description && <p className="truncate text-xs text-muted-foreground">{report.description}</p>}
                  </TableCell>
                  <TableCell>
                    <SoftBadge tone="neutral">{tk[report.kind]}</SoftBadge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <SoftBadge tone={report.visibility === 'workspace' ? 'success' : 'neutral'}>{report.visibility === 'workspace' ? tc.workspace : tc.private}</SoftBadge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{report.ownerUserId === userId ? tc.ownedByYou : tc.shared}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(report.updatedAt, language)}</TableCell>
                  <TableCell>
                    <RowMenu report={report} onRename={() => setRenaming(report)} onDelete={() => setDeleting(report)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <RenameReportDialog report={renaming} onClose={() => setRenaming(null)} />
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
    </div>
  );
}

export default function ReportsPage() {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.reports;
  const canCreate = useCan('panel_reports:create');
  return (
    <AnalyticsPage
      title={tr.title}
      description={tr.description}
      actions={
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
              {(['trends', 'funnel', 'retention', 'flows'] as const).map((kind) => (
                <DropdownMenuItem key={kind} asChild>
                  <Link href={reportBuilderHref(kind)}>{tr.newKinds[kind]}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    >
      {(project) => <ReportsList key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}

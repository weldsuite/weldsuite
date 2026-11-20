/**
 * Raw data export of the current project, the "Data export" tab of the
 * WeldPanel settings (`/settings/apps/weldpanel?tab=exports`, the link the
 * "export failing" email carries). Needs `panel_projects:manage`, like the
 * settings page itself.
 */

import { useState, type ReactNode } from 'react';
import { DatabaseZap } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelExportDto, PanelExportStatus, PanelExportRunStatus } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import {
  useDeleteWeldPanelExport,
  usePauseWeldPanelExport,
  useTestWeldPanelExport,
  useWeldPanelExportRuns,
  useWeldPanelExports,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatBytes } from '../lib/export-providers';
import { formatDateTime, formatNumber } from '../lib/format';
import { useCurrentProject } from '../lib/use-current-project';
import { ExportFormDialog } from './export-form-dialog';

const STATUS_TONES: Record<PanelExportStatus, SoftTone> = {
  active: 'success',
  paused: 'neutral',
  failing: 'danger',
};
const RUN_TONES: Record<PanelExportRunStatus, SoftTone> = {
  running: 'neutral',
  succeeded: 'success',
  failed: 'danger',
};

function RunsDialog({ exportItem, onClose }: Readonly<{ exportItem: PanelExportDto | null; onClose: () => void }>) {
  const { t, language, format } = useI18n();
  const tr = t.weldpanel.collab.exports.runs;
  const te = t.weldpanel.collab.exports;
  const { data: runs, isLoading, isError, refetch } = useWeldPanelExportRuns(exportItem?.id ?? '', exportItem !== null);
  return (
    <Dialog open={exportItem !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{format(tr.title, { name: exportItem?.name ?? '' })}</DialogTitle>
          <DialogDescription>{tr.description}</DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-32 w-full" />}
        {isError && <ErrorState message={tr.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}
        {!isLoading && !isError && (runs ?? []).length === 0 && <p className="text-sm text-muted-foreground">{tr.empty}</p>}
        {runs && runs.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr.columns.table}</TableHead>
                  <TableHead>{tr.columns.window}</TableHead>
                  <TableHead>{tr.columns.status}</TableHead>
                  <TableHead className="text-right">{tr.columns.rows}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{tr.columns.size}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{tr.columns.files}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{te.tables[run.table]}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(run.windowFrom, language)} – {formatDateTime(run.windowTo, language)}
                    </TableCell>
                    <TableCell>
                      <SoftBadge tone={RUN_TONES[run.status]}>{tr.statuses[run.status]}</SoftBadge>
                      {run.error && (
                        <p className="mt-1 max-w-64 truncate text-xs text-destructive" title={run.error}>
                          {run.error}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(run.rows, language)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatBytes(run.bytes, language)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatNumber(run.files, language)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ExportRowProps {
  item: PanelExportDto;
  onEdit: () => void;
  onRuns: () => void;
  onDelete: () => void;
}

/** The row's menu: edit, test the connection, runs, pause or resume, delete. */
function ExportMenuItems({ item, onEdit, onRuns, onDelete }: Readonly<ExportRowProps>) {
  const { t, format } = useI18n();
  const te = t.weldpanel.collab.exports;
  const pause = usePauseWeldPanelExport();
  const test = useTestWeldPanelExport();
  const paused = item.status === 'paused';

  async function togglePause() {
    try {
      await pause.mutateAsync({ id: item.id, pause: !paused });
      toast.success(paused ? te.resumed : te.paused);
    } catch {
      toast.error(te.failed);
    }
  }

  async function runTest() {
    try {
      const result = await test.mutateAsync({ exportId: item.id });
      if (result.ok && result.deleted) toast.success(te.test.ok);
      else if (result.ok || result.wrote) toast.warning(te.test.okNotDeleted);
      else toast.error(result.error ? format(te.test.failed, { error: result.error }) : te.test.failedUnknown);
    } catch {
      toast.error(te.test.failedUnknown);
    }
  }

  return (
    <>
      <DropdownMenuItem onSelect={onEdit}>{te.actions.edit}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void runTest()}>{te.actions.test}</DropdownMenuItem>
      <DropdownMenuItem onSelect={onRuns}>{te.actions.runs}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void togglePause()}>{paused ? te.actions.resume : te.actions.pause}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
        {te.actions.delete}
      </DropdownMenuItem>
    </>
  );
}

function ProjectExports({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language, format } = useI18n();
  const te = t.weldpanel.collab.exports;
  const tc = t.weldpanel.analytics.common;
  const { data: exportsList, isLoading, isError, refetch } = useWeldPanelExports(projectId);
  const remove = useDeleteWeldPanelExport();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PanelExportDto | null>(null);
  const [viewingRuns, setViewingRuns] = useState<PanelExportDto | null>(null);
  const [deleting, setDeleting] = useState<PanelExportDto | null>(null);

  const columns: ColumnDef<PanelExportDto>[] = [
    {
      id: 'name',
      header: te.columns.name,
      width: 'flex-1 min-w-[140px]',
      render: (item) => <span className="block truncate font-medium">{item.name}</span>,
    },
    {
      id: 'destination',
      header: te.columns.destination,
      width: 'hidden md:block md:w-[220px]',
      render: (item) => {
        const prefix = item.destination.prefix ? `/${item.destination.prefix}` : '';
        return <span className="block truncate text-muted-foreground">{`${te.providers[item.destination.provider]} · ${item.destination.bucket}${prefix}`}</span>;
      },
    },
    {
      id: 'tables',
      header: te.columns.tables,
      width: 'hidden xl:block xl:w-[180px]',
      render: (item) => <span className="block truncate text-muted-foreground">{item.tables.map((table) => te.tables[table]).join(', ')}</span>,
    },
    {
      id: 'frequency',
      header: te.columns.frequency,
      width: 'hidden sm:block sm:w-[100px]',
      render: (item) => <span className="block truncate text-muted-foreground">{te.frequencies[item.frequency]}</span>,
    },
    {
      id: 'status',
      header: te.columns.status,
      width: 'w-[100px]',
      render: (item) => <SoftBadge tone={STATUS_TONES[item.status]}>{te.statuses[item.status]}</SoftBadge>,
    },
    {
      id: 'exportedUntil',
      header: te.columns.exportedUntil,
      width: 'hidden md:block md:w-[150px]',
      render: (item) => (
        <span className="block truncate whitespace-nowrap tabular-nums text-muted-foreground">{item.exportedUntil ? formatDateTime(item.exportedUntil, language) : te.notYet}</span>
      ),
    },
    {
      id: 'lastError',
      header: '',
      width: 'hidden xl:block xl:w-[200px]',
      render: (item) =>
        item.lastError ? (
          <span className="block truncate text-destructive" title={item.lastError}>
            {format(te.lastError, { error: item.lastError })}
          </span>
        ) : null,
    },
  ];

  const createAction = {
    label: te.newExport,
    onClick: () => setCreating(true),
  };

  // The shared list words its own loading state in English only.
  let list: ReactNode;
  if (isLoading && !exportsList) {
    list = <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  } else if (isError) {
    list = <ErrorState message={te.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  } else {
    list = (
        <PanelEntityList<PanelExportDto>
          items={exportsList ?? []}
          isLoading={false}
          columns={columns}
          hideFilter
          rowMenu={(item) => <ExportMenuItems item={item} onEdit={() => setEditing(item)} onRuns={() => setViewingRuns(item)} onDelete={() => setDeleting(item)} />}
          searchFields={['name']}
          searchPlaceholder={t.common.actions.search}
          onRowClick={(item) => setEditing(item)}
          createButton={createAction}
          emptyState={{
            icon: <DatabaseZap className="size-8 text-muted-foreground" />,
            title: te.emptyTitle,
            description: te.emptyDescription,
            action: createAction,
          }}
          noResultsState={{
            icon: <DatabaseZap className="size-8 text-muted-foreground" />,
            title: te.emptyTitle,
            description: te.emptyDescription,
          }}
        />
    );
  }

  return (
    <>
      <InfoBanner variant="warning" title={te.erasureTitle} className="mb-4">
        {te.erasureNotice}
      </InfoBanner>
      {list}

      <ExportFormDialog open={creating} onOpenChange={setCreating} projectId={projectId} />
      <ExportFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} projectId={projectId} existing={editing} />
      <RunsDialog exportItem={viewingRuns} onClose={() => setViewingRuns(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(te.deleteTitle, { name: deleting?.name ?? '' })}
        description={te.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(te.deleted);
            setDeleting(null);
          } catch {
            toast.error(te.deleteFailed);
          }
        }}
      />
    </>
  );
}

export function ExportsView() {
  const { t } = useI18n();
  const { project, isLoading } = useCurrentProject();
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!project) return <EmptyState icon={DatabaseZap} title={t.weldpanel.collab.exports.title} description={t.weldpanel.collab.exports.needProject} />;
  return <ProjectExports key={project.id} projectId={project.id} />;
}

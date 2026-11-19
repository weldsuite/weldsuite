/** Metric trees of the current project: open, create, rename through the editor, delete your own. */

import { useState } from 'react';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelMetricTreeDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useDeleteWeldPanelMetricTree, useWeldPanelMetricTrees } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { PanelDefinitionsProvider } from '../components/definitions';
import { formatDate } from '../lib/format';
import { MetricTreeEditor } from './editor';
import { metricTreeHref } from './tree-draft';

function TreeMenuItems({
  tree,
  canUpdate,
  canDelete,
  onEdit,
  onDelete,
}: Readonly<{
  tree: PanelMetricTreeDto;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  return (
    <>
      <DropdownMenuItem onSelect={() => router.push(metricTreeHref(tree.id))}>{tc.open}</DropdownMenuItem>
      {canUpdate && <DropdownMenuItem onSelect={onEdit}>{tc.edit}</DropdownMenuItem>}
      {canDelete && (
        <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
          {tc.delete}
        </DropdownMenuItem>
      )}
    </>
  );
}

function TreeList({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.metricTrees;
  const tc = t.weldpanel.analytics.common;
  const { userId } = useAuth();
  const router = useRouter();
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const { data: trees, isLoading, isError, refetch } = useWeldPanelMetricTrees({ projectId });
  const remove = useDeleteWeldPanelMetricTree();
  const [editing, setEditing] = useState<PanelMetricTreeDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelMetricTreeDto | null>(null);

  const columns: ColumnDef<PanelMetricTreeDto>[] = [
    {
      id: 'name',
      header: tx.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (tree) => <span className="block truncate font-medium">{tree.name}</span>,
    },
    {
      id: 'description',
      header: tc.description,
      width: 'hidden lg:block lg:w-[260px]',
      render: (tree) => <span className="block truncate text-muted-foreground">{tree.description || '–'}</span>,
    },
    {
      id: 'metrics',
      header: tx.columns.metrics,
      width: 'w-[100px]',
      render: (tree) => <span className="block truncate tabular-nums">{format(tx.metricCount, { count: tree.nodes.length })}</span>,
    },
    {
      id: 'visibility',
      header: tx.columns.visibility,
      width: 'hidden md:block md:w-[110px]',
      render: (tree) => <span className="block truncate text-muted-foreground">{tree.visibility === 'private' ? tc.private : tc.workspace}</span>,
    },
    {
      id: 'updated',
      header: tx.columns.updated,
      width: 'hidden md:block md:w-[120px]',
      render: (tree) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(tree.updatedAt, language)}</span>,
    },
  ];

  // The shared list words its own loading state in English only.
  if (isLoading && !trees) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const createAction = canCreate ? { label: tx.newTree, onClick: () => setCreating(true) } : undefined;

  return (
    <>
      <PanelEntityList<PanelMetricTreeDto>
        items={trees ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        rowMenu={(tree) =>
          tree.ownerUserId === userId && (canUpdate || canDelete) ? (
            <TreeMenuItems tree={tree} canUpdate={canUpdate} canDelete={canDelete} onEdit={() => setEditing(tree)} onDelete={() => setDeleting(tree)} />
          ) : null
        }
        searchFields={['name', 'description']}
        searchPlaceholder={t.common.actions.search}
        onRowClick={(tree) => router.push(metricTreeHref(tree.id))}
        createButton={createAction}
        emptyState={{
          icon: <Network className="size-8 text-muted-foreground" />,
          title: tx.emptyTitle,
          description: tx.emptyDescription,
          action: createAction,
        }}
        noResultsState={{
          icon: <Network className="size-8 text-muted-foreground" />,
          title: tx.emptyTitle,
          description: tx.emptyDescription,
        }}
      />
      <MetricTreeEditor
        projectId={projectId}
        tree={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={(tree) => {
          if (creating) router.push(metricTreeHref(tree.id));
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(tx.deleteTitle, { name: deleting?.name ?? '' })}
        description={tx.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tx.deleted);
            setDeleting(null);
          } catch {
            toast.error(tx.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function MetricTreesPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.metricTrees;
  return (
    <AnalyticsListPage title={tx.title}>
      {(project) => (
        <PanelDefinitionsProvider key={project.id} projectId={project.id}>
          <TreeList projectId={project.id} />
        </PanelDefinitionsProvider>
      )}
    </AnalyticsListPage>
  );
}

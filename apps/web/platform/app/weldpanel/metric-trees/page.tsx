/** Metric trees of the current project: open, create, rename through the editor, delete your own. */

import { useState } from 'react';
import { MoreHorizontal, Network, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelMetricTreeDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useDeleteWeldPanelMetricTree, useWeldPanelMetricTrees } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { PanelDefinitionsProvider } from '../components/definitions';
import { formatDate } from '../lib/format';
import { MetricTreeEditor } from './editor';
import { metricTreeHref } from './tree-draft';

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

  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const newButton = canCreate && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {tx.newTree}
    </Button>
  );

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div className="grid gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (!trees || trees.length === 0) {
    body = <EmptyState icon={Network} title={tx.emptyTitle} description={tx.emptyDescription} action={newButton || undefined} />;
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tx.columns.name}</TableHead>
              <TableHead className="text-right">{tx.columns.metrics}</TableHead>
              <TableHead className="hidden md:table-cell">{tx.columns.visibility}</TableHead>
              <TableHead className="hidden md:table-cell">{tx.columns.updated}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {trees.map((tree) => {
              const mine = tree.ownerUserId === userId;
              const showMenu = mine && (canUpdate || canDelete);
              return (
                <TableRow key={tree.id}>
                  <TableCell className="max-w-80">
                    <Link href={metricTreeHref(tree.id)} className="font-medium hover:underline">
                      {tree.name}
                    </Link>
                    {tree.description && <p className="truncate text-xs text-muted-foreground">{tree.description}</p>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{format(tx.metricCount, { count: tree.nodes.length })}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{tree.visibility === 'private' ? tc.private : tc.workspace}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(tree.updatedAt, language)}</TableCell>
                  <TableCell>
                    {showMenu && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={format(tx.actions, { name: tree.name })}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => router.push(metricTreeHref(tree.id))}>{tc.open}</DropdownMenuItem>
                          {canUpdate && <DropdownMenuItem onSelect={() => setEditing(tree)}>{tc.edit}</DropdownMenuItem>}
                          {canDelete && (
                            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(tree)}>
                              {tc.delete}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {trees && trees.length > 0 && newButton && <div className="flex justify-end">{newButton}</div>}
      {body}
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
    </div>
  );
}

export default function MetricTreesPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.metricTrees;
  return (
    <AnalyticsPage title={tx.title} description={tx.description}>
      {(project) => (
        <PanelDefinitionsProvider key={project.id} projectId={project.id}>
          <TreeList projectId={project.id} />
        </PanelDefinitionsProvider>
      )}
    </AnalyticsPage>
  );
}

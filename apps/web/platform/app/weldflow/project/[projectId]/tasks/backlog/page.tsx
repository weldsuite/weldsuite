/**
 * Tasks › Backlog: sprint planning for an agile project (ADR FLOW-022). The
 * epics on the left filter it; the sprints (when the approach has them) and the
 * ordered backlog on the right take items by drag and drop, by menu or in bulk.
 * Where the project is a task list, or the edition has no agile delivery, this
 * sends you to the List.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ItemType, TaskAgileInput } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SubNavSwitch, type SubNavItem } from '@/app/weldflow/components/sub-nav';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { NO_EPIC, isFiltering, nextSprintDraft, typeChangeInput, type BacklogFilter } from '@/app/weldflow/lib/backlog';
import { useObjectPanel } from '@/components/object-panel';
import { useCreateItem, useDeleteItems } from '@/hooks/queries/use-flow-agile-backlog-queries';
import {
  useBulkUpdateTaskAgile,
  useCreateSprint,
  useProjectDelivery,
} from '@/hooks/queries/use-flow-agile-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useRouter } from '@/lib/router';
import { apiMessage } from '../../close/_lib/api-error';
import { BacklogEnvProvider, type BacklogActions, type BacklogEnv } from './_components/backlog-context';
import { BulkBar } from './_components/bulk-bar';
import { EpicsPanel } from './_components/epics-panel';
import { BacklogBoard, BacklogFilterBanner, DeleteBacklogItemsDialog } from './_components/backlog-sections';
import { useBacklogData } from './_components/use-backlog-data';

export default function BacklogPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();
  const { t, plural } = useI18n();
  const copy = t.flowAgileBacklog;
  const { canWrite } = useProjectPermissions();
  const { open: openPanel } = useObjectPanel();

  const delivery = useProjectDelivery(projectId);
  const available = delivery.available && delivery.usesItemTypes;
  const settings = delivery.settings;

  // A task list (or an edition without agile delivery) has no backlog.
  useEffect(() => {
    if (!delivery.isLoading && !available) router.replace(`/weldflow/project/${projectId}/tasks`);
  }, [delivery.isLoading, available, projectId, router]);

  const createItem = useCreateItem(projectId);
  const deleteItems = useDeleteItems(projectId);
  const createSprint = useCreateSprint(projectId);
  const bulkUpdate = useBulkUpdateTaskAgile(projectId);

  const [filter, setFilter] = useState<BacklogFilter>({ epicId: null, search: '', type: null });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const {
    itemsQuery,
    epicsQuery,
    items,
    itemsById,
    allSprints,
    epics,
    epicsById,
    activeSprint,
    plannedSprints,
    openSprints,
    forecast,
    types,
    sections,
  } = useBacklogData({ projectId, available, usesSprints: delivery.usesSprints, enabledTypes: delivery.enabledTypes, filter });

  // Selection follows what exists: an item that was deleted or moved away from the view leaves it.
  const selectedIds = useMemo(() => [...selected].filter((id) => itemsById.has(id)), [selected, itemsById]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const runUpdate = useCallback(
    async (ids: string[], input: TaskAgileInput) => {
      try {
        await bulkUpdate.mutateAsync({ taskIds: ids, input });
        if (ids.length > 1) toast.success(plural(ids.length, copy.bulk.updated));
        setSelected(new Set());
      } catch (error) {
        toast.error(apiMessage(error, ids.length > 1 ? copy.bulk.failed : copy.backlog.updateFailed));
      }
    },
    [bulkUpdate, plural, copy.bulk.updated, copy.bulk.failed, copy.backlog.updateFailed],
  );

  const actions = useMemo<BacklogActions>(
    () => ({
      open: (id) => openPanel({ type: 'task', id }),
      changeType: (ids, type: ItemType) => void runUpdate(ids, typeChangeInput(type)),
      moveToSprint: (ids, sprintId) => void runUpdate(ids, { sprintId }),
      setEpic: (ids, epicId) => void runUpdate(ids, { epicId }),
      turnIntoEpic: (id) => void runUpdate([id], typeChangeInput('epic')),
      requestDelete: (ids) => setPendingDelete(ids),
    }),
    [openPanel, runUpdate],
  );

  const env = useMemo<BacklogEnv>(
    () => ({
      projectId,
      canWrite,
      naming: settings.itemTypes.naming,
      featureLevel: settings.itemTypes.featureLevel,
      usesSprints: delivery.usesSprints,
      types,
      sprints: delivery.usesSprints ? openSprints : [],
      epics,
      epicsById,
      selected,
      toggleSelected: (id) =>
        setSelected((previous) => {
          const next = new Set(previous);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      targetsFor: (id) => (selected.has(id) && selected.size > 1 ? selectedIds : [id]),
      actions,
    }),
    [projectId, canWrite, settings.itemTypes, delivery.usesSprints, types, openSprints, epics, epicsById, selected, selectedIds, actions],
  );

  const confirmDelete = async () => {
    const ids = pendingDelete;
    if (!ids) return;
    try {
      await deleteItems.mutateAsync(ids);
      toast.success(copy.delete.deleted);
      setSelected(new Set());
    } catch (error) {
      toast.error(apiMessage(error, copy.delete.failed));
    } finally {
      setPendingDelete(null);
    }
  };

  const createInSection = (sprintId: string | null) => async ({ title, type }: { title: string; type: ItemType }) => {
    try {
      await createItem.mutateAsync({ title, type, sprintId, epicId: filter.epicId && filter.epicId !== NO_EPIC ? filter.epicId : null });
    } catch (error) {
      toast.error(apiMessage(error, copy.quick.failed));
      throw error;
    }
  };

  const createEpic = async (title: string) => {
    try {
      await createItem.mutateAsync({ title, type: 'epic' });
    } catch (error) {
      toast.error(apiMessage(error, copy.epics.createFailed));
      throw error;
    }
  };

  const newSprint = () => {
    const draft = nextSprintDraft(allSprints, settings.sprintLengthDays, new Date(), copy.sprint.newName);
    createSprint.mutate(draft, {
      onSuccess: () => toast.success(copy.backlog.sprintCreated),
      onError: (error) => toast.error(apiMessage(error, copy.backlog.newSprintFailed)),
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const viewItems: SubNavItem[] = [
    { id: 'list', label: t.flowAgile.views.list, path: '' },
    { id: 'backlog', label: t.flowAgile.views.backlog, path: '/backlog' },
  ];
  const viewSwitch = (
    <SubNavSwitch label={copy.switchLabel} basePath={`/weldflow/project/${projectId}/tasks`} items={viewItems} activeId="backlog" />
  );

  if (delivery.isLoading || !available) return <PageLoader fullScreen={false} />;

  const filteredEpic = filter.epicId && filter.epicId !== NO_EPIC ? epicsById.get(filter.epicId) : undefined;
  const showEmpty = !itemsQuery.isLoading && items.length === 0 && !isFiltering(filter);
  const createProps = {
    canWrite,
    types,
    naming: settings.itemTypes.naming,
    featureLevel: settings.itemTypes.featureLevel,
    createInSection,
  };

  return (
    <BacklogEnvProvider value={env}>
      <div className="flex min-h-0 flex-1 flex-col">
        <ListToolbar
          className="shrink-0 pt-2 pb-2"
          leftActionButtons={viewSwitch}
          search={filter.search}
          onSearchChange={(search) => setFilter((previous) => ({ ...previous, search }))}
          searchPlaceholder={copy.backlog.searchPlaceholder}
          actionButtons={
            canWrite && delivery.usesSprints ? (
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={newSprint} disabled={createSprint.isPending}>
                <Plus aria-hidden className="h-4 w-4" />
                {copy.backlog.newSprint}
              </Button>
            ) : undefined
          }
        />
        <div className="shrink-0 overflow-x-auto border-b border-border px-3 py-2 md:hidden">{viewSwitch}</div>

        <div className="px-3 pt-4 pb-8 md:px-4">
          {itemsQuery.isLoading ? <PageLoader fullScreen={false} /> : null}
          {itemsQuery.isError && !itemsQuery.data ? (
            <ErrorState message={copy.backlog.loadFailed} onRetry={() => void itemsQuery.refetch()} retryLabel={t.flowAgile.shared.retry} />
          ) : null}

          {!itemsQuery.isLoading && !(itemsQuery.isError && !itemsQuery.data) ? (
            <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
              <EpicsPanel
                epics={epics}
                loading={epicsQuery.isLoading}
                failed={epicsQuery.isError}
                selected={filter.epicId}
                onSelect={(epicId) => setFilter((previous) => ({ ...previous, epicId }))}
                naming={settings.itemTypes.naming}
                featureLevel={settings.itemTypes.featureLevel}
                projectId={projectId}
                canCreate={canWrite && types.includes('epic')}
                onCreate={createEpic}
              />

              <div className="flex min-w-0 flex-col gap-4">
                <BacklogFilterBanner
                  epicId={filter.epicId}
                  epicTitle={filteredEpic?.title}
                  onClear={() => setFilter((previous) => ({ ...previous, epicId: null }))}
                />

                {showEmpty ? <EmptyState title={copy.backlog.emptyTitle} description={copy.backlog.emptyDescription} /> : null}

                <BacklogBoard
                  projectId={projectId}
                  sections={sections}
                  itemsById={itemsById}
                  allSprints={allSprints}
                  usesSprints={delivery.usesSprints}
                  activeSprint={activeSprint}
                  plannedSprints={plannedSprints}
                  forecast={forecast}
                  filtering={isFiltering(filter)}
                  {...createProps}
                />
              </div>
            </div>
          ) : null}

          <BulkBar ids={selectedIds} onClear={clearSelection} />
        </div>
      </div>

      <DeleteBacklogItemsDialog
        pendingDelete={pendingDelete}
        itemsById={itemsById}
        loading={deleteItems.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </BacklogEnvProvider>
  );
}

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
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { ItemType, TaskAgileInput } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SubNavSwitch, type SubNavItem } from '@/app/weldflow/components/sub-nav';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { averageVelocity } from '@/app/weldflow/lib/delivery';
import type { ApiTask } from '@/app/weldflow/lib/api-client';
import {
  BACKLOG_SECTION,
  NO_EPIC,
  buildSections,
  countUnestimated,
  dropItem,
  isFiltering,
  nextSprintDraft,
  pickableTypes,
  sectionSprintId,
  sumPoints,
  typeChangeInput,
  type BacklogFilter,
  type DropResult,
} from '@/app/weldflow/lib/backlog';
import { useObjectPanel } from '@/components/object-panel';
import { QuickCreateItem } from '@/components/weldflow/agile/quick-create-item';
import { agileBacklogKeys, useBacklogItems, useCreateItem, useDeleteItems, useReorderItems } from '@/hooks/queries/use-flow-agile-backlog-queries';
import {
  useBulkUpdateTaskAgile,
  useCreateSprint,
  useProjectDelivery,
  useProjectEpics,
  useProjectSprints,
  useUpdateTaskAgile,
} from '@/hooks/queries/use-flow-agile-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useRouter } from '@/lib/router';
import { apiMessage } from '../../close/_lib/api-error';
import { BacklogEnvProvider, type BacklogActions, type BacklogEnv } from './_components/backlog-context';
import { BacklogList } from './_components/backlog-list';
import { BacklogRowOverlay } from './_components/backlog-row';
import { BulkBar } from './_components/bulk-bar';
import { EpicsPanel } from './_components/epics-panel';
import { ActiveSprintCard, PlannedSprintSection } from './_components/sprint-sections';

export default function BacklogPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const qc = useQueryClient();
  const { canWrite } = useProjectPermissions();
  const { open: openPanel } = useObjectPanel();

  const delivery = useProjectDelivery(projectId);
  const available = delivery.available && delivery.usesItemTypes;
  const settings = delivery.settings;

  // A task list (or an edition without agile delivery) has no backlog.
  useEffect(() => {
    if (!delivery.isLoading && !available) router.replace(`/weldflow/project/${projectId}/tasks`);
  }, [delivery.isLoading, available, projectId, router]);

  const itemsQuery = useBacklogItems(projectId, available);
  const sprintsQuery = useProjectSprints(projectId, available && delivery.usesSprints);
  const epicsQuery = useProjectEpics(projectId, available);
  const createItem = useCreateItem(projectId);
  const deleteItems = useDeleteItems(projectId);
  const reorder = useReorderItems(projectId);
  const createSprint = useCreateSprint(projectId);
  const updateAgile = useUpdateTaskAgile(projectId);
  const bulkUpdate = useBulkUpdateTaskAgile(projectId);

  const [filter, setFilter] = useState<BacklogFilter>({ epicId: null, search: '', type: null });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const allSprints = useMemo(() => sprintsQuery.data ?? [], [sprintsQuery.data]);
  const epics = useMemo(() => epicsQuery.data ?? [], [epicsQuery.data]);
  const epicsById = useMemo(() => new Map(epics.map((epic) => [epic.id, epic])), [epics]);

  const activeSprint = allSprints.find((sprint) => sprint.status === 'active');
  const plannedSprints = useMemo(
    () =>
      allSprints
        .filter((sprint) => sprint.status === 'planned')
        .sort((a, b) => (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999') || a.name.localeCompare(b.name)),
    [allSprints],
  );
  const openSprints = useMemo(() => (activeSprint ? [activeSprint, ...plannedSprints] : plannedSprints), [activeSprint, plannedSprints]);
  const sprintIds = useMemo(() => (delivery.usesSprints ? openSprints.map((sprint) => sprint.id) : []), [delivery.usesSprints, openSprints]);
  const forecast = useMemo(() => averageVelocity(allSprints), [allSprints]);
  const types = useMemo(() => pickableTypes(delivery.enabledTypes), [delivery.enabledTypes]);

  const sections = useMemo(() => buildSections(items, sprintIds, filter), [items, sprintIds, filter]);
  const backlogItems = sections[BACKLOG_SECTION] ?? [];

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

  // ── Drag and drop ─────────────────────────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // An item under the pointer wins over the section around it; an empty section is the fallback.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const hits = pointerWithin(args);
      const onItem = hits.find((hit) => !(String(hit.id) in sections));
      if (onItem) return [onItem];
      return hits.length > 0 ? hits : closestCenter(args);
    },
    [sections],
  );

  const sectionName = useCallback(
    (id: string) => (id === BACKLOG_SECTION ? copy.backlog.sectionTitle : (allSprints.find((sprint) => sprint.id === id)?.name ?? id)),
    [allSprints, copy.backlog.sectionTitle],
  );
  const announcements = useMemo<Announcements>(() => {
    const title = (id: string | number) => itemsById.get(String(id))?.title ?? String(id);
    const target = (id: string | number) =>
      String(id) in sections ? format(copy.dnd.section, { name: sectionName(String(id)) }) : title(id);
    return {
      onDragStart: ({ active }) => format(copy.dnd.pickedUp, { title: title(active.id) }),
      onDragOver: ({ active, over }) => (over ? format(copy.dnd.movedOver, { title: title(active.id), target: target(over.id) }) : undefined),
      onDragEnd: ({ active }) => format(copy.dnd.dropped, { title: title(active.id) }),
      onDragCancel: ({ active }) => format(copy.dnd.cancelled, { title: title(active.id) }),
    };
  }, [itemsById, sections, format, copy.dnd, sectionName]);

  /** Show the drop at once; the refetch after saving makes it the server's. */
  const applyOptimistic = (result: DropResult) => {
    const sprintId = sectionSprintId(result.targetId);
    const positions = new Map(result.targetOrder.map((id, index) => [id, index]));
    qc.setQueryData<ApiTask[]>(agileBacklogKeys.items(projectId), (old) =>
      old?.map((task) =>
        positions.has(task.id) ? { ...task, sprintId: sprintId ?? undefined, position: positions.get(task.id) ?? task.position } : task,
      ),
    );
  };

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const onDragEnd = async (event: DragEndEvent) => {
    setDraggingId(null);
    if (!event.over) return;
    const activeId = String(event.active.id);
    const result = dropItem(sections, activeId, String(event.over.id));
    if (!result) return;
    applyOptimistic(result);
    try {
      if (result.sourceId !== undefined) {
        await updateAgile.mutateAsync({ taskId: activeId, input: { sprintId: sectionSprintId(result.targetId) } });
      }
      await reorder.mutateAsync(result.targetOrder);
    } catch (error) {
      toast.error(apiMessage(error, copy.backlog.moveFailed));
      await qc.invalidateQueries({ queryKey: agileBacklogKeys.items(projectId) });
    }
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

  const draggingItem = draggingId ? itemsById.get(draggingId) : undefined;
  const filteredEpic = filter.epicId && filter.epicId !== NO_EPIC ? epicsById.get(filter.epicId) : undefined;
  const showEmpty = !itemsQuery.isLoading && items.length === 0 && !isFiltering(filter);

  const backlogSection = (
    <section aria-labelledby="backlog-heading" className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <h2 id="backlog-heading" className="text-[15px] font-semibold">
            {copy.backlog.sectionTitle}
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {plural(backlogItems.length, copy.backlog.items)} · {format(copy.backlog.pointsEstimated, { points: plural(sumPoints(backlogItems), t.flowAgile.points) })}
          </span>
        </div>
        {canWrite ? (
          <span className="text-[13px] text-muted-foreground">{delivery.usesSprints ? copy.backlog.orderHint : copy.backlog.orderHintKanban}</span>
        ) : null}
      </div>
      <BacklogList
        sectionId={BACKLOG_SECTION}
        items={backlogItems}
        label={copy.backlog.sectionTitle}
        emptyText={isFiltering(filter) ? copy.backlog.noMatches : copy.backlog.dropBacklog}
      />
      {canWrite ? (
        <div className="border-t border-border">
          <QuickCreateItem
            types={types}
            naming={settings.itemTypes.naming}
            featureLevel={settings.itemTypes.featureLevel}
            placeholder={copy.quick.placeholder}
            onCreate={createInSection(null)}
          />
          {countUnestimated(backlogItems) > 0 ? (
            <p className="px-4 pb-2.5 text-xs text-muted-foreground">{plural(countUnestimated(backlogItems), copy.backlog.unestimated)}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );

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
                {filter.epicId !== null ? (
                  <InfoBanner
                    variant="neutral"
                    action={
                      <Button type="button" variant="ghost" size="sm" onClick={() => setFilter((previous) => ({ ...previous, epicId: null }))}>
                        {copy.backlog.clearFilter}
                      </Button>
                    }
                  >
                    {filteredEpic ? format(copy.backlog.filteredByEpic, { name: filteredEpic.title }) : copy.backlog.filteredByNoEpic}
                  </InfoBanner>
                ) : null}

                {showEmpty ? (
                  <EmptyState title={copy.backlog.emptyTitle} description={copy.backlog.emptyDescription} />
                ) : null}

                <DndContext
                  sensors={sensors}
                  collisionDetection={collisionDetection}
                  onDragStart={onDragStart}
                  onDragEnd={(event) => void onDragEnd(event)}
                  onDragCancel={() => setDraggingId(null)}
                  accessibility={{
                    announcements,
                    screenReaderInstructions: { draggable: copy.dnd.instructions },
                  }}
                >
                  {delivery.usesSprints && activeSprint ? (
                    <ActiveSprintCard sprint={activeSprint} items={sections[activeSprint.id] ?? []} projectId={projectId} canWrite={canWrite} />
                  ) : null}

                  {delivery.usesSprints
                    ? plannedSprints.map((sprint) => (
                        <PlannedSprintSection
                          key={sprint.id}
                          sprint={sprint}
                          items={sections[sprint.id] ?? []}
                          forecast={forecast}
                          activeSprint={activeSprint}
                          projectId={projectId}
                          canWrite={canWrite}
                        >
                          <BacklogList
                            sectionId={sprint.id}
                            items={sections[sprint.id] ?? []}
                            label={sprint.name}
                            emptyText={copy.sprint.emptySprint}
                          />
                          {canWrite ? (
                            <div className="border-t border-border">
                              <QuickCreateItem
                                types={types}
                                naming={settings.itemTypes.naming}
                                featureLevel={settings.itemTypes.featureLevel}
                                placeholder={format(copy.quick.placeholderSprint, { name: sprint.name })}
                                onCreate={createInSection(sprint.id)}
                              />
                            </div>
                          ) : null}
                        </PlannedSprintSection>
                      ))
                    : null}

                  {backlogSection}

                  <DragOverlay>{draggingItem ? <BacklogRowOverlay item={draggingItem} /> : null}</DragOverlay>
                </DndContext>
              </div>
            </div>
          ) : null}

          <BulkBar ids={selectedIds} onClear={clearSelection} />
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={
          pendingDelete && pendingDelete.length === 1
            ? copy.delete.title
            : plural(pendingDelete?.length ?? 0, copy.delete.titleMany)
        }
        description={
          pendingDelete && pendingDelete.length === 1
            ? format(copy.delete.description, { title: itemsById.get(pendingDelete[0] ?? '')?.title ?? '' })
            : copy.delete.descriptionMany
        }
        confirmLabel={copy.delete.confirm}
        cancelLabel={t.flowAgile.shared.cancel}
        variant="destructive"
        loading={deleteItems.isPending}
        onConfirm={confirmDelete}
      />
    </BacklogEnvProvider>
  );
}

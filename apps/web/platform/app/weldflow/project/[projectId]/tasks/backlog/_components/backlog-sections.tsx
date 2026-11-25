/**
 * The list sections of the Backlog page: the ordered backlog, the planned
 * sprints (each with its own quick create) and the delete confirmation.
 */

import type { ReactNode } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import type { ItemType, ItemTypeNaming, Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { BACKLOG_SECTION, countUnestimated, sumPoints, type BacklogItem } from '@/app/weldflow/lib/backlog';
import { QuickCreateItem } from '@/components/weldflow/agile/quick-create-item';
import { useI18n } from '@/lib/i18n/provider';
import { BacklogList } from './backlog-list';
import { BacklogRowOverlay } from './backlog-row';
import { ActiveSprintCard, PlannedSprintSection } from './sprint-sections';
import { useBacklogDnd } from './use-backlog-dnd';

interface CreateProps {
  canWrite: boolean;
  types: readonly ItemType[];
  naming: ItemTypeNaming;
  featureLevel: boolean;
  createInSection: (sprintId: string | null) => (input: { title: string; type: ItemType }) => Promise<void>;
}

export function BacklogSection({
  items,
  usesSprints,
  filtering,
  canWrite,
  types,
  naming,
  featureLevel,
  createInSection,
}: Readonly<CreateProps & { items: readonly BacklogItem[]; usesSprints: boolean; filtering: boolean }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const unestimated = countUnestimated(items);
  let hint: ReactNode = null;
  if (canWrite) {
    hint = <span className="text-[13px] text-muted-foreground">{usesSprints ? copy.backlog.orderHint : copy.backlog.orderHintKanban}</span>;
  }
  return (
    <section aria-labelledby="backlog-heading" className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <h2 id="backlog-heading" className="text-[15px] font-semibold">
            {copy.backlog.sectionTitle}
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {plural(items.length, copy.backlog.items)} · {format(copy.backlog.pointsEstimated, { points: plural(sumPoints(items), t.flowAgile.points) })}
          </span>
        </div>
        {hint}
      </div>
      <BacklogList
        sectionId={BACKLOG_SECTION}
        items={items}
        label={copy.backlog.sectionTitle}
        emptyText={filtering ? copy.backlog.noMatches : copy.backlog.dropBacklog}
      />
      {canWrite ? (
        <div className="border-t border-border">
          <QuickCreateItem
            types={types}
            naming={naming}
            featureLevel={featureLevel}
            placeholder={copy.quick.placeholder}
            onCreate={createInSection(null)}
          />
          {unestimated > 0 ? <p className="px-4 pb-2.5 text-xs text-muted-foreground">{plural(unestimated, copy.backlog.unestimated)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function PlannedSprints({
  sprints,
  sections,
  forecast,
  activeSprint,
  projectId,
  canWrite,
  types,
  naming,
  featureLevel,
  createInSection,
}: Readonly<
  CreateProps & {
    sprints: readonly Sprint[];
    sections: Record<string, BacklogItem[]>;
    forecast: number | null;
    activeSprint: Sprint | undefined;
    projectId: string;
  }
>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog;
  return (
    <>
      {sprints.map((sprint) => (
        <PlannedSprintSection
          key={sprint.id}
          sprint={sprint}
          items={sections[sprint.id] ?? []}
          forecast={forecast}
          activeSprint={activeSprint}
          projectId={projectId}
          canWrite={canWrite}
        >
          <BacklogList sectionId={sprint.id} items={sections[sprint.id] ?? []} label={sprint.name} emptyText={copy.sprint.emptySprint} />
          {canWrite ? (
            <div className="border-t border-border">
              <QuickCreateItem
                types={types}
                naming={naming}
                featureLevel={featureLevel}
                placeholder={format(copy.quick.placeholderSprint, { name: sprint.name })}
                onCreate={createInSection(sprint.id)}
              />
            </div>
          ) : null}
        </PlannedSprintSection>
      ))}
    </>
  );
}

export function DeleteBacklogItemsDialog({
  pendingDelete,
  itemsById,
  loading,
  onCancel,
  onConfirm,
}: Readonly<{
  pendingDelete: string[] | null;
  itemsById: ReadonlyMap<string, BacklogItem>;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const single = pendingDelete !== null && pendingDelete.length === 1;
  const title = single ? copy.delete.title : plural(pendingDelete?.length ?? 0, copy.delete.titleMany);
  const description = single
    ? format(copy.delete.description, { title: itemsById.get(pendingDelete[0] ?? '')?.title ?? '' })
    : copy.delete.descriptionMany;
  return (
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={title}
      description={description}
      confirmLabel={copy.delete.confirm}
      cancelLabel={t.flowAgile.shared.cancel}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}

export function BacklogFilterBanner({
  epicId,
  epicTitle,
  onClear,
}: Readonly<{ epicId: string | null; epicTitle: string | undefined; onClear: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog;
  if (epicId === null) return null;
  return (
    <InfoBanner
      variant="neutral"
      action={
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          {copy.backlog.clearFilter}
        </Button>
      }
    >
      {epicTitle ? format(copy.backlog.filteredByEpic, { name: epicTitle }) : copy.backlog.filteredByNoEpic}
    </InfoBanner>
  );
}

/** The sprints and the backlog as drop targets, with the drag overlay. */
export function BacklogBoard({
  projectId,
  sections,
  itemsById,
  allSprints,
  usesSprints,
  activeSprint,
  plannedSprints,
  forecast,
  filtering,
  ...createProps
}: Readonly<
  CreateProps & {
    projectId: string;
    sections: Record<string, BacklogItem[]>;
    itemsById: ReadonlyMap<string, BacklogItem>;
    allSprints: readonly Sprint[];
    usesSprints: boolean;
    activeSprint: Sprint | undefined;
    plannedSprints: readonly Sprint[];
    forecast: number | null;
    filtering: boolean;
  }
>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog;
  const dnd = useBacklogDnd({ projectId, sections, itemsById, allSprints });
  const draggingItem = dnd.draggingId ? itemsById.get(dnd.draggingId) : undefined;
  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={dnd.collisionDetection}
      onDragStart={dnd.onDragStart}
      onDragEnd={(event) => void dnd.onDragEnd(event)}
      onDragCancel={dnd.onDragCancel}
      accessibility={{
        announcements: dnd.announcements,
        screenReaderInstructions: { draggable: copy.dnd.instructions },
      }}
    >
      {usesSprints && activeSprint ? (
        <ActiveSprintCard sprint={activeSprint} items={sections[activeSprint.id] ?? []} projectId={projectId} canWrite={createProps.canWrite} />
      ) : null}

      {usesSprints ? (
        <PlannedSprints
          sprints={plannedSprints}
          sections={sections}
          forecast={forecast}
          activeSprint={activeSprint}
          projectId={projectId}
          {...createProps}
        />
      ) : null}

      <BacklogSection items={sections[BACKLOG_SECTION] ?? []} usesSprints={usesSprints} filtering={filtering} {...createProps} />

      <DragOverlay>{draggingItem ? <BacklogRowOverlay item={draggingItem} /> : null}</DragOverlay>
    </DndContext>
  );
}

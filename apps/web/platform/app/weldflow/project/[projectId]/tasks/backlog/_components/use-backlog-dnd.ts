/**
 * Drag and drop of the Backlog: sensors, collision detection, screen reader
 * announcements and the drop itself (shown at once, saved, and refetched when
 * saving fails).
 */

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
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
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import type { ApiTask } from '@/app/weldflow/lib/api-client';
import { BACKLOG_SECTION, dropItem, sectionSprintId, type BacklogItem, type DropResult } from '@/app/weldflow/lib/backlog';
import { agileBacklogKeys, useReorderItems } from '@/hooks/queries/use-flow-agile-backlog-queries';
import { useUpdateTaskAgile } from '@/hooks/queries/use-flow-agile-queries';
import { useI18n } from '@/lib/i18n/provider';
import { apiMessage } from '../../../close/_lib/api-error';

export function useBacklogDnd({
  projectId,
  sections,
  itemsById,
  allSprints,
}: Readonly<{
  projectId: string;
  sections: Record<string, BacklogItem[]>;
  itemsById: ReadonlyMap<string, BacklogItem>;
  allSprints: readonly Sprint[];
}>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const qc = useQueryClient();
  const updateAgile = useUpdateTaskAgile(projectId);
  const reorder = useReorderItems(projectId);
  const [draggingId, setDraggingId] = useState<string | null>(null);

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
  const onDragCancel = () => setDraggingId(null);
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

  return { sensors, collisionDetection, announcements, draggingId, onDragStart, onDragEnd, onDragCancel };
}

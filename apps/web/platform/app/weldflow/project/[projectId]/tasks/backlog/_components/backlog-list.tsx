/**
 * The sortable list of one section (a sprint or the backlog). The whole list is
 * a drop target, so an empty section accepts items too.
 */

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import type { BacklogItem } from '@/app/weldflow/lib/backlog';
import { SortableBacklogRow } from './backlog-row';

export function BacklogList({
  sectionId,
  items,
  label,
  emptyText,
}: Readonly<{ sectionId: string; items: readonly BacklogItem[]; label: string; emptyText: string }>) {
  const { setNodeRef, isOver } = useDroppable({ id: sectionId });
  return (
    <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
      <ol ref={setNodeRef} aria-label={label} className={cn('m-0 list-none p-0 transition-colors', isOver && 'bg-blue-50/60 dark:bg-blue-500/5')}>
        {items.length === 0 ? (
          <li className="list-none px-4 py-6 text-center text-sm text-muted-foreground">{emptyText}</li>
        ) : (
          items.map((item) => <SortableBacklogRow key={item.id} item={item} />)
        )}
      </ol>
    </SortableContext>
  );
}

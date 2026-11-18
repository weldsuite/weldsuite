import type { ReactNode } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface SortableListProps<T> {
  items: readonly T[];
  /** A stable id per item (not its index: the index changes as it moves). */
  getId: (item: T) => string;
  onReorder: (items: T[]) => void;
  /** The row's content; the drag handle is drawn before it. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Accessible name of an item's drag handle ("Drag rule 2 to reorder"). */
  handleLabel: (item: T, index: number) => string;
  /** Turns dragging off (read-only lists); the handles are hidden. */
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}

function SortableRow({
  id,
  handleLabel,
  disabled,
  className,
  children,
}: Readonly<{ id: string; handleLabel: string; disabled: boolean; className?: string; children: ReactNode }>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-start gap-2 rounded-lg border bg-card p-3', isDragging && 'relative z-10 shadow-md', className)}
    >
      {!disabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="mt-1 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
          aria-label={handleLabel}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/**
 * A vertical list whose rows are reordered by dragging a handle (mouse, touch,
 * or the keyboard: focus the handle, Space to lift, arrows to move, Space to
 * drop). Ordered rules, steps and priorities.
 */
export function SortableList<T>({ items, getId, onReorder, renderItem, handleLabel, disabled = false, className, itemClassName }: Readonly<SortableListProps<T>>) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const ids = items.map(getId);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove([...items], from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled}>
        <ol className={cn('grid gap-2', className)}>
          {items.map((item, index) => (
            <SortableRow key={ids[index]} id={ids[index]!} handleLabel={handleLabel(item, index)} disabled={disabled} className={itemClassName}>
              {renderItem(item, index)}
            </SortableRow>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

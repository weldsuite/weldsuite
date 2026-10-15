import type { Dispatch } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, EyeOff, GripVertical, Lock, LockOpen } from 'lucide-react';
import type { TemplateBlock, TemplateBlockType, TemplateField } from '@weldsuite/books-domain/invoice-template/schema';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { BLOCK_ICONS, blockLabel } from './block-icons';
import type { EditorAction } from './model/editor-reducer';

interface LayersPanelProps {
  blocks: TemplateBlock[];
  selection: string[];
  readOnly: boolean;
  fieldNames: Record<TemplateField, string>;
  dispatch: Dispatch<EditorAction>;
}

interface LayerRowProps {
  block: TemplateBlock;
  label: string;
  selected: boolean;
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
}

function LayerRow({ block, label, selected, readOnly, dispatch }: Readonly<LayerRowProps>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.layers;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: readOnly });
  const Icon = BLOCK_ICONS[block.type];
  const iconButton = 'rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex items-center gap-0.5 rounded-md pr-0.5',
        selected ? 'bg-accent' : 'hover:bg-accent/50',
        isDragging && 'relative z-10 bg-background shadow-md ring-1 ring-border',
        block.hidden && 'opacity-60',
      )}
    >
      <button
        type="button"
        className={cn(iconButton, 'cursor-grab touch-none')}
        aria-label={`${tl.reorder}: ${label}`}
        disabled={readOnly}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 text-left text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={(e) => dispatch({ type: 'select', ids: [block.id], mode: e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace' })}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        className={iconButton}
        aria-label={`${block.hidden ? tl.show : tl.hide}: ${label}`}
        aria-pressed={Boolean(block.hidden)}
        disabled={readOnly}
        onClick={() => dispatch({ type: 'updateBlocks', ids: [block.id], update: { hidden: block.hidden ? undefined : true } })}
      >
        {block.hidden ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <button
        type="button"
        className={cn(iconButton, !block.locked && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
        aria-label={`${block.locked ? tl.unlock : tl.lock}: ${label}`}
        aria-pressed={Boolean(block.locked)}
        disabled={readOnly}
        onClick={() => dispatch({ type: 'updateBlocks', ids: [block.id], update: { locked: block.locked ? undefined : true } })}
      >
        {block.locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </li>
  );
}

/** Blocks top to bottom in paint order. Drag to reorder, eye hides, padlock locks, click selects. */
export function LayersPanel({ blocks, selection, readOnly, fieldNames, dispatch }: Readonly<LayersPanelProps>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.layers;
  const names = t.accounting.invoiceTemplates.blocks as Record<TemplateBlockType, string>;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Array order is paint order (last on top); the list shows the top layer first.
  const displayed = [...blocks].reverse();
  const selected = new Set(selection);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = displayed.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    dispatch({ type: 'setOrder', order: arrayMove(ids, from, to).reverse() });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tl.title}</h2>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {displayed.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{tl.empty}</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={displayed.map((b) => b.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-0.5">
                {displayed.map((block) => (
                  <LayerRow
                    key={block.id}
                    block={block}
                    label={blockLabel(block, names, fieldNames)}
                    selected={selected.has(block.id)}
                    readOnly={readOnly}
                    dispatch={dispatch}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

import { useMemo, useState, type Dispatch } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, EyeOff, GripVertical, Lock, LockOpen, Search } from 'lucide-react';
import type { TemplateBlock, TemplateBlockType, TemplateField } from '@weldsuite/books-domain/invoice-template/schema';
import { Input } from '@weldsuite/ui/components/input';
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
  /** Reordering is off while the list is filtered: moving within a partial list would be guesswork. */
  sortable: boolean;
  dispatch: Dispatch<EditorAction>;
}

const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30';

/** Shows on hover, keyboard focus or selection; `pinned` keeps it visible (a hidden or locked layer shows its state). */
const revealed = (pinned: boolean) => (pinned ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[selected=true]:opacity-100');

function LayerRow({ block, label, selected, readOnly, sortable, dispatch }: Readonly<LayerRowProps>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.layers;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: readOnly || !sortable });
  const Icon = BLOCK_ICONS[block.type];
  const hidden = Boolean(block.hidden);
  const locked = Boolean(block.locked);

  return (
    <li
      ref={setNodeRef}
      data-selected={selected}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex h-10 items-center gap-1 rounded-lg pl-2 pr-2 transition-colors',
        selected ? 'bg-accent ring-1 ring-border' : 'hover:bg-muted/60',
        isDragging && 'relative z-10 bg-background shadow-lg ring-1 ring-border',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={(e) => dispatch({ type: 'select', ids: [block.id], mode: e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace' })}
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors group-hover:text-foreground',
            selected && 'bg-background text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </span>
        <span className={cn('truncate text-[13px]', hidden ? 'text-muted-foreground line-through decoration-muted-foreground/50' : 'text-foreground')}>
          {label}
        </span>
      </button>
      {/* Lock, eye and drag handle as one tight group. */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={cn(iconButton, 'h-6 w-6', revealed(locked))}
          aria-label={`${locked ? tl.unlock : tl.lock}: ${label}`}
          aria-pressed={locked}
          disabled={readOnly}
          onClick={() => dispatch({ type: 'updateBlocks', ids: [block.id], update: { locked: locked ? undefined : true } })}
        >
          {locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}
        </button>
        {block.type === 'lineItems' ? (
          // Every invoice prints its line items, so there is nothing to hide: keep the column, drop the button.
          <span className="h-6 w-6 shrink-0" aria-hidden />
        ) : (
          <button
            type="button"
            className={cn(iconButton, 'h-6 w-6', revealed(hidden))}
            aria-label={`${hidden ? tl.show : tl.hide}: ${label}`}
            aria-pressed={hidden}
            disabled={readOnly}
            onClick={() => dispatch({ type: 'updateBlocks', ids: [block.id], update: { hidden: hidden ? undefined : true } })}
          >
            {hidden ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
          </button>
        )}
        <button
          type="button"
          className={cn(iconButton, 'h-6 w-6 cursor-grab touch-none active:cursor-grabbing', revealed(false), !sortable && 'invisible')}
          aria-label={`${tl.reorder}: ${label}`}
          disabled={readOnly || !sortable}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </li>
  );
}

/** Blocks top to bottom in paint order, with a search. Drag to reorder, eye hides, padlock locks, click selects. */
export function LayersPanel({ blocks, selection, readOnly, fieldNames, dispatch }: Readonly<LayersPanelProps>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.layers;
  const names = t.accounting.invoiceTemplates.blocks as Record<TemplateBlockType, string>;
  const [query, setQuery] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Array order is paint order (last on top); the list shows the top layer first.
  const layers = useMemo(() => [...blocks].reverse().map((block) => ({ block, label: blockLabel(block, names, fieldNames) })), [blocks, names, fieldNames]);
  const q = query.trim().toLocaleLowerCase();
  const shown = q ? layers.filter((l) => l.label.toLocaleLowerCase().includes(q) || names[l.block.type].toLocaleLowerCase().includes(q)) : layers;
  const selected = new Set(selection);
  let message: string | null = null;
  if (layers.length === 0) message = tl.empty;
  else if (shown.length === 0) message = tl.noResults.replace('{query}', query.trim());

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = layers.map((l) => l.block.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    dispatch({ type: 'setOrder', order: arrayMove(ids, from, to).reverse() });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tl.search}
            aria-label={tl.search}
            className="h-8 pl-8 text-sm shadow-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
        {message ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{message}</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown.map((l) => l.block.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-0.5">
                {shown.map(({ block, label }) => (
                  <LayerRow
                    key={block.id}
                    block={block}
                    label={label}
                    selected={selected.has(block.id)}
                    readOnly={readOnly}
                    sortable={!q}
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

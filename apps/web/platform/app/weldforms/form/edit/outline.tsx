/**
 * The left panel of the Create tab: the welcome screen, the blocks (drag to
 * reorder, groups with children), the endings, and the add-block menu.
 */

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ArrowDown, ArrowUp, Copy, GripVertical, ListTree, MoreHorizontal, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  createEnding,
  createField,
  createGroup,
  createPageBreak,
  createStatement,
  uniqueRef,
  type Block,
  type FieldType,
  type FormDefinition,
} from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  addBlock,
  addBlockAfter,
  duplicateBlock,
  locate,
  moveBlock,
  nudgeBlock,
  removeBlock,
  selectionAfterRemoval,
} from '../../lib/blocks';
import { BLOCK_ICONS, ENDING_ICON, type BlockKind } from '../../lib/block-types';
import { useAiAvailable } from '../../lib/ai-availability';
import { useFormEditor, type Selection } from '../editor-context';
import { AddBlockMenu } from './add-block-menu';

/** A new block of any kind, with a ref no other block uses. */
export function newBlock(def: FormDefinition, kind: BlockKind): Block {
  const ref = uniqueRef(def, kind);
  switch (kind) {
    case 'statement':
      return createStatement({ ref });
    case 'group':
      return createGroup({ ref });
    case 'page_break':
      return createPageBreak({ ref });
    default:
      return createField(kind as FieldType, { ref });
  }
}

interface RowProps {
  block: Block;
  depth: number;
  /** The question number shown before the title; null for blocks that aren't questions. */
  number: number | null;
  selected: boolean;
  issueCount: number;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onSelect: () => void;
}

function BlockRow({ block, depth, number, selected, issueCount, canEdit, first, last, onSelect }: Readonly<RowProps>) {
  const { t } = useI18n();
  const editor = useFormEditor();
  const to = t.weldforms.outline;
  const names = t.weldforms.blockTypes as Record<string, string>;
  const Icon = BLOCK_ICONS[block.type as BlockKind];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: !canEdit });

  const untitled = block.type === 'page_break' ? names.page_break : to.untitled;
  const title = block.title.trim() === '' ? untitled : block.title;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn('group flex items-center gap-1 rounded-md border border-transparent pr-1 text-sm', selected ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60')}
    >
      {canEdit ? (
        <button
          type="button"
          className="grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          style={{ marginLeft: depth * 14 }}
          aria-label={to.drag}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : (
        <span className="w-6" style={{ marginLeft: depth * 14 }} />
      )}
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left focus-visible:outline-none" aria-current={selected ? 'true' : undefined}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {number !== null && <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{number}</span>}
        <span className={cn('truncate', block.title.trim() === '' && 'italic text-muted-foreground')}>{title}</span>
      </button>
      {issueCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-amber-600" role="img" aria-label={to.issues.replace('{count}', String(issueCount))}>
              <AlertTriangle className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{to.issues.replace('{count}', String(issueCount))}</TooltipContent>
        </Tooltip>
      )}
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={t.common.actions.openMenu}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={first} onSelect={() => editor.editDefinition((d) => nudgeBlock(d, block.id, -1))}>
              <ArrowUp className="size-4" />
              {to.moveUp}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={last} onSelect={() => editor.editDefinition((d) => nudgeBlock(d, block.id, 1))}>
              <ArrowDown className="size-4" />
              {to.moveDown}
            </DropdownMenuItem>
            {block.type !== 'page_break' && (
              <DropdownMenuItem onSelect={() => editor.editDefinition((d) => duplicateBlock(d, block.id))}>
                <Copy className="size-4" />
                {to.duplicate}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                const next = selectionAfterRemoval(editor.definition, block.id);
                editor.editDefinition((d) => removeBlock(d, block.id));
                if (selected) editor.select(next ? { kind: 'block', id: next } : null);
              }}
            >
              <Trash2 className="size-4" />
              {t.common.actions.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

interface OutlineProps {
  onDataClick: () => void;
  onAiClick: () => void;
}

export function Outline({ onDataClick, onAiClick }: Readonly<OutlineProps>) {
  const { t } = useI18n();
  const to = t.weldforms.outline;
  const editor = useFormEditor();
  const { definition: def, selection, canEdit } = editor;
  const aiAvailable = useAiAvailable();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const flatIds = def.blocks.flatMap((b) => (b.type === 'group' ? [b.id, ...b.children.map((c) => c.id)] : [b.id]));

  function select(next: Selection) {
    editor.select(next);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const target = locate(def, String(over.id));
    if (!target) return;
    editor.editDefinition((d) => moveBlock(d, String(active.id), target.index, target.parentId));
  }

  function add(kind: BlockKind, parentId?: string) {
    const block = newBlock(def, kind);
    const selectedId = selection?.kind === 'block' ? selection.id : null;
    editor.editDefinition((d) => (parentId ? addBlock(d, block, { parentId }) : addBlockAfter(d, block, selectedId)));
    select({ kind: 'block', id: block.id });
  }

  let questionNumber = 0;
  const issuesFor = (id: string) => editor.issuesByBlock.get(id)?.length ?? 0;
  const topBlocks = def.blocks;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Welcome screen */}
        <div>
          <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.welcome}</div>
          {def.welcome ? (
            <button
              type="button"
              onClick={() => select({ kind: 'welcome' })}
              className={cn('flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm', selection?.kind === 'welcome' ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60')}
            >
              <ListTree className="size-4 text-muted-foreground" aria-hidden />
              <span className="truncate">{def.welcome.title || to.welcome}</span>
            </button>
          ) : (
            canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  editor.editDefinition((d) => ({ ...d, welcome: { title: to.welcomeDefaultTitle } }));
                  select({ kind: 'welcome' });
                }}
              >
                <Plus className="size-4" />
                {to.addWelcome}
              </Button>
            )
          )}
        </div>

        {/* Blocks */}
        <div>
          <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.questions}</div>
          {topBlocks.length === 0 && <p className="px-1 py-2 text-sm text-muted-foreground">{to.empty}</p>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {topBlocks.map((block, index) => {
                  const isField = block.type !== 'statement' && block.type !== 'group' && block.type !== 'page_break';
                  if (isField) questionNumber += 1;
                  const groupSelected = block.type === 'group' && selection?.kind === 'block' && selection.id === block.id;
                  return (
                    <div key={block.id}>
                      <BlockRow
                        block={block}
                        depth={0}
                        number={isField ? questionNumber : null}
                        selected={selection?.kind === 'block' && selection.id === block.id}
                        issueCount={issuesFor(block.id)}
                        canEdit={canEdit}
                        first={index === 0}
                        last={index === topBlocks.length - 1}
                        onSelect={() => select({ kind: 'block', id: block.id })}
                      />
                      {block.type === 'group' && (
                        <div className="space-y-0.5">
                          {block.children.map((child, childIndex) => {
                            const childIsField = child.type !== 'statement';
                            if (childIsField) questionNumber += 1;
                            return (
                              <BlockRow
                                key={child.id}
                                block={child}
                                depth={1}
                                number={childIsField ? questionNumber : null}
                                selected={selection?.kind === 'block' && selection.id === child.id}
                                issueCount={issuesFor(child.id)}
                                canEdit={canEdit}
                                first={childIndex === 0}
                                last={childIndex === block.children.length - 1}
                                onSelect={() => select({ kind: 'block', id: child.id })}
                              />
                            );
                          })}
                          {canEdit && (groupSelected || block.children.length === 0) && (
                            <AddBlockMenu layout={def.presentation.layout} insideGroup onAdd={(kind) => add(kind, block.id)}>
                              <Button type="button" variant="ghost" size="xs" className="ml-9 text-muted-foreground">
                                <Plus />
                                {to.addToGroup}
                              </Button>
                            </AddBlockMenu>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
          {canEdit && (
            <div className="mt-2 flex flex-wrap gap-2">
              <AddBlockMenu layout={def.presentation.layout} onAdd={(kind) => add(kind)}>
                <Button type="button" variant="outline" size="sm">
                  <Plus className="size-4" />
                  {to.addBlock}
                </Button>
              </AddBlockMenu>
              {aiAvailable && (
                <Button type="button" variant="outline" size="sm" onClick={onAiClick}>
                  <Sparkles className="size-4" />
                  {to.addWithAi}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Endings */}
        <div>
          <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.endings}</div>
          <div className="space-y-0.5">
            {def.endings.map((ending) => {
              const active = selection?.kind === 'ending' && selection.id === ending.id;
              return (
                <button
                  key={ending.id}
                  type="button"
                  onClick={() => select({ kind: 'ending', id: ending.id })}
                  className={cn('flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm', active ? 'border-primary/40 bg-primary/5' : 'hover:bg-accent/60')}
                >
                  <ENDING_ICON className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{ending.title || to.untitled}</span>
                </button>
              );
            })}
          </div>
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start"
              onClick={() => {
                const ending = createEnding({ ref: uniqueRef(def, 'ending'), title: to.newEndingTitle });
                editor.editDefinition((x) => ({ ...x, endings: [...x.endings, ending] }));
                select({ kind: 'ending', id: ending.id });
              }}
            >
              <Plus className="size-4" />
              {to.addEnding}
            </Button>
          )}
        </div>
      </div>
      <div className="border-t p-2">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={onDataClick}>
          {to.hiddenAndVariables}
        </Button>
      </div>
    </div>
  );
}

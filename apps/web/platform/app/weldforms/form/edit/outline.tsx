/**
 * The left panel of the Create tab: the welcome screen, the blocks (drag to
 * reorder, groups with children), the endings, and the add-block menu. Laid
 * out like the module sidebar beside it: group labels, menu rows with the
 * selection filled, and dashed "add" rows like its Invite members button.
 */

import type { ComponentProps, ReactNode } from 'react';
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
import { AlertTriangle, ArrowDown, ArrowUp, Braces, Copy, EllipsisVertical, GripVertical, ListTree, Plus, Trash2 } from 'lucide-react';
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
import { useFormEditor, type Selection } from '../editor-context';
import { AddBlockMenu } from './add-block-menu';

/** A row, as the sidebar's menu buttons: 32px, the selected one filled. */
const ROW = 'group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors';
const ROW_SELECTED = 'bg-accent font-medium text-accent-foreground';
const ROW_IDLE = 'hover:bg-accent/60';
/**
 * An "add" row: dashed, like the sidebar's Invite members button, 34px tall,
 * its + and label where a row's icon and title sit (7px padding plus the 1px
 * border, over the Button's own 12px beside an icon).
 */
const ADD_ROW =
  'h-[34px] w-full justify-start gap-2 rounded-md border border-dashed border-muted-foreground/30 px-[7px] has-[>svg]:px-[7px] py-0 text-sm font-normal text-muted-foreground hover:border-muted-foreground/50 hover:bg-accent/40 hover:text-foreground dark:hover:bg-accent/40';

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

/** A section's label, as the sidebar's `SidebarGroupLabel`, with its + on the right, which stays visible. */
function SectionHeader({ label, children }: Readonly<{ label: string; children?: ReactNode }>) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 pl-2 pr-1.5">
      <h3 className="truncate text-xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </div>
  );
}

/**
 * The + of a section header. Spreads what a wrapping trigger (the add-block
 * menu's popover) passes, so it works on its own and as that trigger.
 */
function AddButton({ label, ...props }: Readonly<{ label: string } & ComponentProps<typeof Button>>) {
  return (
    <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={label} title={label} {...props}>
      <Plus />
    </Button>
  );
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
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, paddingLeft: 8 + depth * 20 }}
      className={cn(ROW, 'pr-1.5', selected ? ROW_SELECTED : ROW_IDLE)}
    >
      {/* The block's icon; on hover, the drag handle in its place. */}
      <span className="relative grid size-4 shrink-0 place-items-center">
        <Icon className={cn('size-4 text-muted-foreground', canEdit && 'group-hover:opacity-0')} aria-hidden />
        {canEdit && (
          <button
            type="button"
            className="absolute inset-0 grid cursor-grab touch-none place-items-center text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
            aria-label={to.drag}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        )}
      </span>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left focus-visible:outline-none" aria-current={selected ? 'true' : undefined}>
        {number !== null && <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{number}.</span>}
        <span className={cn('truncate', block.title.trim() === '' && 'font-normal italic text-muted-foreground')}>{title}</span>
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
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100"
              aria-label={t.common.actions.openMenu}
            >
              <EllipsisVertical className="size-4" />
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
}

export function Outline({ onDataClick }: Readonly<OutlineProps>) {
  const { t } = useI18n();
  const to = t.weldforms.outline;
  const editor = useFormEditor();
  const { definition: def, selection, canEdit } = editor;

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

  function addWelcome() {
    editor.editDefinition((d) => ({ ...d, welcome: { title: to.welcomeDefaultTitle } }));
    select({ kind: 'welcome' });
  }

  function addEnding() {
    const ending = createEnding({ ref: uniqueRef(def, 'ending'), title: to.newEndingTitle });
    editor.editDefinition((x) => ({ ...x, endings: [...x.endings, ending] }));
    select({ kind: 'ending', id: ending.id });
  }

  let questionNumber = 0;
  const issuesFor = (id: string) => editor.issuesByBlock.get(id)?.length ?? 0;
  const topBlocks = def.blocks;

  const welcomeSelected = selection?.kind === 'welcome';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {/* Welcome screen */}
        <section>
          <SectionHeader label={to.welcome}>
            {canEdit && <AddButton label={to.addWelcome} disabled={Boolean(def.welcome)} onClick={addWelcome} />}
          </SectionHeader>
          {def.welcome ? (
            <button type="button" onClick={() => select({ kind: 'welcome' })} aria-current={welcomeSelected ? 'true' : undefined} className={cn(ROW, welcomeSelected ? ROW_SELECTED : ROW_IDLE)}>
              <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{def.welcome.title || to.welcome}</span>
            </button>
          ) : (
            canEdit && (
              <Button type="button" variant="ghost" className={ADD_ROW} onClick={addWelcome}>
                <Plus className="size-4" />
                {to.addWelcome}
              </Button>
            )
          )}
        </section>

        {/* Blocks */}
        <section>
          <SectionHeader label={to.questions}>
            {canEdit && (
              <AddBlockMenu layout={def.presentation.layout} onAdd={(kind) => add(kind)}>
                <AddButton label={to.addBlock} />
              </AddBlockMenu>
            )}
          </SectionHeader>
          {topBlocks.length === 0 && !canEdit && <p className="px-2 py-1.5 text-sm text-muted-foreground">{to.empty}</p>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-px">
                {topBlocks.map((block, index) => {
                  const isField = block.type !== 'statement' && block.type !== 'group' && block.type !== 'page_break';
                  if (isField) questionNumber += 1;
                  const groupSelected = block.type === 'group' && selection?.kind === 'block' && selection.id === block.id;
                  return (
                    <div key={block.id} className="space-y-px">
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
                      {block.type === 'group' &&
                        block.children.map((child, childIndex) => {
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
                      {block.type === 'group' && canEdit && (groupSelected || block.children.length === 0) && (
                        <div className="pl-5">
                          <AddBlockMenu layout={def.presentation.layout} insideGroup onAdd={(kind) => add(kind, block.id)}>
                            <Button type="button" variant="ghost" className={ADD_ROW}>
                              <Plus className="size-4" />
                              {to.addToGroup}
                            </Button>
                          </AddBlockMenu>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
          {canEdit && topBlocks.length === 0 && (
            <div>
              <AddBlockMenu layout={def.presentation.layout} onAdd={(kind) => add(kind)}>
                <Button type="button" variant="ghost" className={ADD_ROW}>
                  <Plus className="size-4" />
                  {to.addBlock}
                </Button>
              </AddBlockMenu>
            </div>
          )}
        </section>

        {/* Endings */}
        <section>
          <SectionHeader label={to.endings}>{canEdit && <AddButton label={to.addEnding} onClick={addEnding} />}</SectionHeader>
          <div className="space-y-px">
            {def.endings.map((ending) => {
              const active = selection?.kind === 'ending' && selection.id === ending.id;
              return (
                <button
                  key={ending.id}
                  type="button"
                  onClick={() => select({ kind: 'ending', id: ending.id })}
                  aria-current={active ? 'true' : undefined}
                  className={cn(ROW, active ? ROW_SELECTED : ROW_IDLE)}
                >
                  <ENDING_ICON className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{ending.title || to.untitled}</span>
                </button>
              );
            })}
          </div>
          {canEdit && def.endings.length === 0 && (
            <Button type="button" variant="ghost" className={ADD_ROW} onClick={addEnding}>
              <Plus className="size-4" />
              {to.addEnding}
            </Button>
          )}
        </section>
      </div>
      <div className="border-t p-2">
        <button type="button" onClick={onDataClick} className={cn(ROW, ROW_IDLE)}>
          <Braces className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{to.hiddenAndVariables}</span>
        </button>
      </div>
    </div>
  );
}

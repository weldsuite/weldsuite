import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from './model/sheet-controller';
import { formatStat } from './stats-format';

const TAB_COLORS = ['#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6fa8dc', '#8e7cc3', '#c27ba0'];

export function SheetTabs({ controller }: { controller: SheetController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, format } = useI18n();
  const tt = t.weldsheets.tabs;
  const sheets = controller.engine.workbook.sheets;
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The sheet whose Rename was picked in its menu, renamed once the menu has closed. */
  const renameAfterMenu = useRef<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The tab being dragged over: a line shows on the side the dragged tab lands. */
  const [over, setOver] = useState<string | null>(null);

  const commitRename = (sheetId: string, name: string) => {
    setRenaming(null);
    const sheet = controller.engine.workbook.getSheet(sheetId);
    if (!sheet || name.trim() === sheet.name) return;
    if (!controller.renameSheet(sheetId, name)) toast.error(tt.invalidName);
  };

  const deletingSheet = deleting ? controller.engine.workbook.getSheet(deleting) : undefined;
  // Without edit rights tabs only switch sheets.
  const editable = !controller.readOnly;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-t bg-muted/40 text-sm">
      {editable && (
        <button
          type="button"
          className="flex w-9 shrink-0 items-center justify-center hover:bg-accent"
          onClick={() => controller.addSheet()}
          aria-label={tt.addSheet}
          title={tt.addSheet}
        >
          <Plus className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist">
        {sheets.map((sheet, index) => {
          const active = sheet.id === controller.activeSheetId;
          return (
            <ContextMenu key={sheet.id}>
              <ContextMenuTrigger asChild disabled={!editable}>
                <div
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  draggable={editable && renaming !== sheet.id}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(sheet.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragging && over !== sheet.id) setOver(sheet.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === sheet.id ? null : o));
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDrop={() => {
                    if (dragging && dragging !== sheet.id) controller.moveSheet(dragging, index);
                    setDragging(null);
                    setOver(null);
                  }}
                  onClick={() => controller.setActiveSheet(sheet.id)}
                  onKeyDown={(e) => {
                    // A focused tab: Enter or Space opens its sheet, F2 renames it (as a double click does).
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      controller.setActiveSheet(sheet.id);
                    } else if (e.key === 'F2' && editable) {
                      e.preventDefault();
                      setRenaming(sheet.id);
                    }
                  }}
                  onDoubleClick={() => editable && setRenaming(sheet.id)}
                  className={`relative flex max-w-48 shrink-0 cursor-pointer items-center border-r px-4 ${
                    active ? 'bg-background font-medium text-primary' : 'text-muted-foreground hover:bg-accent'
                  } ${dragging === sheet.id ? 'opacity-50' : ''}`}
                  style={{ boxShadow: sheet.props.tabColor ? `inset 0 -3px 0 ${sheet.props.tabColor}` : undefined }}
                >
                  {renaming === sheet.id ? (
                    <RenameField
                      name={sheet.name}
                      label={t.weldsheets.editor.renameSheet}
                      onCommit={(name) => commitRename(sheet.id, name)}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <span className="truncate">{sheet.name}</span>
                  )}
                  {over === sheet.id && dragging && dragging !== sheet.id && (
                    // Dragged rightwards a tab lands after this one, leftwards before it.
                    <span
                      aria-hidden
                      className={`pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary forced-colors:bg-[Highlight] ${
                        sheets.findIndex((x) => x.id === dragging) < index ? '-right-px' : '-left-px'
                      }`}
                    />
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={(e) => {
                  // Rename opens the tab's field once the menu is gone: closing, the menu hands
                  // the focus back to the grid, and the field (opened earlier) lost it.
                  const id = renameAfterMenu.current;
                  if (!id) return;
                  renameAfterMenu.current = null;
                  e.preventDefault();
                  setRenaming(id);
                }}
              >
                <ContextMenuItem
                  onSelect={() => {
                    renameAfterMenu.current = sheet.id;
                  }}
                >
                  {tt.rename}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => controller.duplicateSheet(sheet.id)}>{tt.duplicate}</ContextMenuItem>
                <ContextMenuItem variant="destructive" disabled={sheets.length <= 1} onSelect={() => setDeleting(sheet.id)}>
                  {tt.delete}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuSub>
                  <ContextMenuSubTrigger>{tt.color}</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="p-2">
                    <div className="grid grid-cols-4 gap-1">
                      {TAB_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          aria-label={color}
                          className="h-5 w-5 rounded-sm border"
                          style={{ backgroundColor: color }}
                          onClick={() => controller.setTabColor(sheet.id, color)}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      className="mt-2 w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      onClick={() => controller.setTabColor(sheet.id, null)}
                    >
                      {t.weldsheets.toolbar.resetColor}
                    </button>
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={index === 0} onSelect={() => controller.moveSheet(sheet.id, index - 1)}>
                  {tt.moveLeft}
                </ContextMenuItem>
                <ContextMenuItem disabled={index === sheets.length - 1} onSelect={() => controller.moveSheet(sheet.id, index + 1)}>
                  {tt.moveRight}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <SelectionStats controller={controller} />
      <ConfirmDialog
        open={!!deletingSheet}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tt.deleteTitle}
        description={format(tt.deleteDescription, { name: deletingSheet?.name ?? '' })}
        confirmLabel={tt.delete}
        variant="destructive"
        onConfirm={() => {
          if (deleting) controller.deleteSheet(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * The inline tab-name field. Enter and Escape are consumed here (preventDefault + stopPropagation):
 * once the field unmounts, focus falls back to the grid, and an Enter that was not cancelled would
 * insert a newline into the grid's cell editor and later erase the cell. IME confirmation
 * (isComposing) is ignored. A settled field never commits again from the blur that unmounting fires.
 * Closing it hands the keyboard back to the grid, unless the person clicked somewhere else.
 */
function RenameField({
  name,
  label,
  onCommit,
  onCancel,
}: {
  name: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const settled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // Focused (its text selected, by onFocus) as soon as it opens.
  useEffect(() => ref.current?.focus(), []);
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.querySelector<HTMLTextAreaElement>('textarea[data-sheet-editor]')?.focus({ preventScroll: true });
      });
    },
    [],
  );
  const commit = (value: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  return (
    <input
      ref={ref}
      defaultValue={name}
      aria-label={label}
      className="w-28 bg-transparent outline-none"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}

function SelectionStats({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const stats = controller.selectionStats();
  if (!stats || stats.count === 0) return null;
  const te = t.weldsheets.editor;
  const fmt = (n: number) => formatStat(n, controller.options.locale);
  const parts =
    stats.numbers > 0
      ? [`${te.sum}: ${fmt(stats.sum)}`, `${te.average}: ${fmt(stats.sum / stats.numbers)}`, `${te.count}: ${stats.count}`]
      : [`${te.count}: ${stats.count}`];
  return (
    // On a phone the tabs need the room more than the sums do.
    <div className="flex shrink-0 items-center gap-4 px-4 text-xs text-muted-foreground max-sm:hidden">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

import { useState, useSyncExternalStore } from 'react';
import { Plus } from 'lucide-react';
import { formatValue } from '@weldsuite/sheets-engine';
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from './model/sheet-controller';

const TAB_COLORS = ['#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6fa8dc', '#8e7cc3', '#c27ba0'];

export function SheetTabs({ controller }: { controller: SheetController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, format } = useI18n();
  const tt = t.weldsheets.tabs;
  const sheets = controller.engine.workbook.sheets;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

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
                  onDragStart={() => setDragging(sheet.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragging && dragging !== sheet.id) controller.moveSheet(dragging, index);
                    setDragging(null);
                  }}
                  onClick={() => controller.setActiveSheet(sheet.id)}
                  onDoubleClick={() => editable && setRenaming(sheet.id)}
                  className={`relative flex max-w-48 shrink-0 cursor-pointer items-center border-r px-4 ${
                    active ? 'bg-background font-medium text-primary' : 'text-muted-foreground hover:bg-accent'
                  }`}
                  style={{ boxShadow: sheet.props.tabColor ? `inset 0 -3px 0 ${sheet.props.tabColor}` : undefined }}
                >
                  {renaming === sheet.id ? (
                    <input
                      autoFocus
                      defaultValue={sheet.name}
                      aria-label={t.weldsheets.editor.renameSheet}
                      className="w-28 bg-transparent outline-none"
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => commitRename(sheet.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(sheet.id, e.currentTarget.value);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="truncate">{sheet.name}</span>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setRenaming(sheet.id)}>{tt.rename}</ContextMenuItem>
                <ContextMenuItem onSelect={() => controller.duplicateSheet(sheet.id)}>{tt.duplicate}</ContextMenuItem>
                <ContextMenuItem disabled={sheets.length <= 1} onSelect={() => setDeleting(sheet.id)}>
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

function SelectionStats({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const stats = controller.selectionStats();
  if (!stats || stats.count === 0) return null;
  const te = t.weldsheets.editor;
  const fmt = (n: number) => formatValue(n, '#,##0.##', controller.options.locale).text;
  const parts =
    stats.numbers > 0
      ? [`${te.sum}: ${fmt(stats.sum)}`, `${te.average}: ${fmt(stats.sum / stats.numbers)}`, `${te.count}: ${stats.count}`]
      : [`${te.count}: ${stats.count}`];
  return (
    <div className="flex shrink-0 items-center gap-4 px-4 text-xs text-muted-foreground">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

import { useI18n } from '@/lib/i18n/provider';
import {
  Copy,
  Scissors,
  Clipboard,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Table,
  Filter,
  History,
  Link,
  MessageSquarePlus,
  StickyNote,
  CircleChevronDown,
  Sparkles,
  EllipsisVertical,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { CellCoord } from './types';

interface SpreadsheetContextMenuProps {
  type: 'cell' | 'column-header' | 'row-number';
  coord: CellCoord;
  x: number;
  y: number;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onPasteValuesOnly: () => void;
  onPasteFormatOnly: () => void;
  onPasteFormulaOnly: () => void;
  onPasteTransposed: () => void;
  onInsertRowAbove: (rowIdx: number) => void;
  onInsertRowBelow: (rowIdx: number) => void;
  onDeleteRow: (rowIdx: number) => void;
  onInsertColumnLeft: (colIdx: number) => void;
  onInsertColumnRight: (colIdx: number) => void;
  onDeleteColumn: (colIdx: number) => void;
  onInsertCellsShiftRight: () => void;
  onInsertCellsShiftDown: () => void;
  onDeleteCellsShiftLeft: () => void;
  onDeleteCellsShiftUp: () => void;
  onConvertToTable: () => void;
  onCreateFilter: () => void;
  onInsertLink: () => void;
  onInsertNote: () => void;
  onGetLinkToCell: () => void;
  onDropdownChip: () => void;
  /** Heavy subsystems not yet built — surfaces a "coming soon" toast. */
  onComingSoon: (feature: string) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

// SubTrigger doesn't inherit the icon sizing/gap that DropdownMenuItem applies,
// so match it here for visual parity with the top-level items.
const SUB_TRIGGER_CLASS =
  "gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

export function SpreadsheetContextMenu({
  type,
  coord,
  x,
  y,
  onClose,
  onCut,
  onCopy,
  onPaste,
  onPasteValuesOnly,
  onPasteFormatOnly,
  onPasteFormulaOnly,
  onPasteTransposed,
  onInsertRowAbove,
  onInsertRowBelow,
  onDeleteRow,
  onInsertColumnLeft,
  onInsertColumnRight,
  onDeleteColumn,
  onInsertCellsShiftRight,
  onInsertCellsShiftDown,
  onDeleteCellsShiftLeft,
  onDeleteCellsShiftUp,
  onConvertToTable,
  onCreateFilter,
  onInsertLink,
  onInsertNote,
  onGetLinkToCell,
  onDropdownChip,
  onComingSoon,
}: SpreadsheetContextMenuProps) {
  const { t } = useI18n();

  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Invisible zero-size trigger anchored at the cursor position. */}
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={0}
        className="min-w-[300px]"
        onContextMenu={(e) => e.preventDefault()}
      >
        {type === 'cell' && (
          <>
            <DropdownMenuItem onSelect={onCut}>
              <Scissors />
              <span className="flex-1">{t.projects.table.cut}</span>
              <DropdownMenuShortcut>{`${MOD}X`}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopy}>
              <Copy />
              <span className="flex-1">{t.projects.table.copy}</span>
              <DropdownMenuShortcut>{`${MOD}C`}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPaste}>
              <Clipboard />
              <span className="flex-1">{t.projects.table.paste}</span>
              <DropdownMenuShortcut>{`${MOD}V`}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <Clipboard />
                <span className="flex-1">{t.projects.table.pasteSpecial}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[260px]">
                <DropdownMenuItem onSelect={onPasteValuesOnly}>
                  <span className="flex-1">{t.projects.table.pasteValuesOnly}</span>
                  <DropdownMenuShortcut>{isMac ? '⌘⇧V' : 'Ctrl+Shift+V'}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onPasteFormatOnly}>{t.projects.table.pasteFormatOnly}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onPasteFormulaOnly}>{t.projects.table.pasteFormulaOnly}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.pasteConditionalFormattingOnly)}>{t.projects.table.pasteConditionalFormattingOnly}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.pasteDataValidationOnly)}>{t.projects.table.pasteDataValidationOnly}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onPasteTransposed}>{t.projects.table.pasteTransposed}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.pasteColumnWidthOnly)}>{t.projects.table.pasteColumnWidthOnly}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.pasteAllExceptBorders)}>{t.projects.table.pasteAllExceptBorders}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={() => onInsertRowAbove(coord.row)}>
              <Plus />
              {t.projects.table.insertOneRowAbove}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInsertColumnLeft(coord.col)}>
              <Plus />
              {t.projects.table.insertOneColumnLeft}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <Plus />
                <span className="flex-1">{t.projects.table.insertCells}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={onInsertCellsShiftRight}>{t.projects.table.insertCellsShiftRight}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onInsertCellsShiftDown}>{t.projects.table.insertCellsShiftDown}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={() => onDeleteRow(coord.row)}>
              <Trash2 />
              {t.projects.table.deleteRow}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDeleteColumn(coord.col)}>
              <Trash2 />
              {t.projects.table.deleteColumn}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <Trash2 />
                <span className="flex-1">{t.projects.table.deleteCells}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={onDeleteCellsShiftLeft}>{t.projects.table.deleteCellsShiftLeft}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onDeleteCellsShiftUp}>{t.projects.table.deleteCellsShiftUp}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={onConvertToTable}>
              <Table />
              <span className="flex-1">{t.projects.table.convertToTable}</span>
              <span className="ml-auto rounded-full bg-green-700 px-2 py-0.5 text-[10px] font-medium leading-none text-white">
                {t.projects.table.badgeNew}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCreateFilter}>
              <Filter />
              {t.projects.table.createFilter}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.showEditHistory)}>
              <History />
              {t.projects.table.showEditHistory}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={onInsertLink}>
              <Link />
              {t.projects.table.insertLink}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.comment)}>
              <MessageSquarePlus />
              <span className="flex-1">{t.projects.table.comment}</span>
              <DropdownMenuShortcut>{isMac ? '⌘⌥M' : 'Ctrl+Alt+M'}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onInsertNote}>
              <StickyNote />
              {t.projects.table.insertNote}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.prebuiltTables)}>
              <Table />
              {t.projects.table.prebuiltTables}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDropdownChip}>
              <CircleChevronDown />
              {t.projects.table.dropdownChip}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <Sparkles />
                <span className="flex-1">{t.projects.table.smartChips}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipPeople)}>{t.projects.table.smartChipPeople}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipFile)}>{t.projects.table.smartChipFile}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipCalendarEvents)}>{t.projects.table.smartChipCalendarEvents}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipPlace)}>{t.projects.table.smartChipPlace}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipFinance)}>{t.projects.table.smartChipFinance}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.smartChipRating)}>{t.projects.table.smartChipRating}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <EllipsisVertical />
                <span className="flex-1">{t.projects.table.viewMoreCellActions}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[220px]">
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.conditionalFormatting)}>{t.projects.table.conditionalFormatting}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.dataValidation)}>{t.projects.table.dataValidation}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onGetLinkToCell}>{t.projects.table.getLinkToCell}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.defineNamedRange)}>{t.projects.table.defineNamedRange}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onComingSoon(t.projects.table.protectRange)}>{t.projects.table.protectRange}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {type === 'column-header' && (
          <>
            <DropdownMenuItem onSelect={() => onInsertColumnLeft(coord.col)}>
              <ArrowLeft />
              {t.projects.table.insertColumnLeft}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInsertColumnRight(coord.col)}>
              <ArrowRight />
              {t.projects.table.insertColumnRight}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDeleteColumn(coord.col)}>
              <Trash2 />
              {t.projects.table.deleteColumn}
            </DropdownMenuItem>
          </>
        )}

        {type === 'row-number' && (
          <>
            <DropdownMenuItem onSelect={() => onInsertRowAbove(coord.row)}>
              <ArrowUp />
              {t.projects.table.insertRowAbove}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInsertRowBelow(coord.row)}>
              <ArrowDown />
              {t.projects.table.insertRowBelow}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDeleteRow(coord.row)}>
              <Trash2 />
              {t.projects.table.deleteRow}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

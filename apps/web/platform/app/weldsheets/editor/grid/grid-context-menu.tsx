import type { ReactNode } from 'react';
import { colToLetters } from '@weldsuite/sheets-engine';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import { useI18n } from '@/lib/i18n/provider';
import { insertChart, removeChart } from '../model/charts';
import { copySelection, pasteInto } from '../model/clipboard';
import { clampToGrid, isWholeColumns, isWholeRows, primaryRange } from '../model/selection';
import type { SheetController } from '../model/sheet-controller';
import { fitToData } from './autofit';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function GridContextMenu({ controller, onCreatePivot, children }: { controller: SheetController; onCreatePivot?: () => void; children: ReactNode }) {
  const { t, format } = useI18n();
  const tm = t.weldsheets.menu;
  const sheet = controller.sheet;
  const range = clampToGrid(primaryRange(controller.selection), sheet.rowCount, sheet.colCount);
  const rows = range.r2 - range.r1 + 1;
  const cols = range.c2 - range.c1 + 1;
  const wholeCols = isWholeColumns(primaryRange(controller.selection));
  const wholeRows = isWholeRows(primaryRange(controller.selection));
  const commentItem = (
    <ContextMenuItem onSelect={() => controller.startComment()}>
      {t.weldsheets.comments.comment}
      <ContextMenuShortcut>{MOD}Alt+M</ContextMenuShortcut>
    </ContextMenuItem>
  );
  /** A picked chart gets its own menu. */
  const chartMenu = !!controller.chart && !controller.readOnly;

  const copy = async (cut: boolean) => {
    const payload = copySelection(controller, cut);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(payload.text).catch(() => toast.error(tm.pasteBlocked));
    }
  };

  const paste = async (valuesOnly = false) => {
    try {
      const text = await navigator.clipboard.readText();
      pasteInto(controller, text, null, valuesOnly);
    } catch {
      toast.info(tm.pasteBlocked);
    }
  };

  const insertLabel = (single: string, plural: string, count: number) => (count > 1 ? format(plural, { count }) : single);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {chartMenu && (
        <ContextMenuContent className="w-64">
          <ContextMenuItem onSelect={() => controller.openPanel('chart')}>{t.weldsheets.charts.edit}</ContextMenuItem>
          <ContextMenuItem onSelect={() => removeChart(controller, controller.chart!.id)}>
            {t.weldsheets.charts.delete}
            <ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
      {!chartMenu && controller.readOnly && (
        <ContextMenuContent className="w-64">
          <ContextMenuItem onSelect={() => void copy(false)}>
            {tm.copy}
            <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
          </ContextMenuItem>
          {controller.mayComment && commentItem}
        </ContextMenuContent>
      )}
      {!chartMenu && !controller.readOnly && (
        <ContextMenuContent className="w-64">
          <ContextMenuItem onSelect={() => void copy(true)}>
            {tm.cut}
            <ContextMenuShortcut>{MOD}X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(false)}>
            {tm.copy}
            <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void paste()}>
            {tm.paste}
            <ContextMenuShortcut>{MOD}V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void paste(true)}>
            {tm.pasteValues}
            <ContextMenuShortcut>{MOD}Shift+V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {!wholeCols && (
            <>
              <ContextMenuItem onSelect={() => controller.insertDims('row', 'before')}>
                {insertLabel(tm.insertRowAbove, tm.insertRowsAbove, rows)}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => controller.insertDims('row', 'after')}>
                {insertLabel(tm.insertRowBelow, tm.insertRowsBelow, rows)}
              </ContextMenuItem>
            </>
          )}
          {!wholeRows && (
            <>
              <ContextMenuItem onSelect={() => controller.insertDims('col', 'before')}>
                {insertLabel(tm.insertColumnLeft, tm.insertColumnsLeft, cols)}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => controller.insertDims('col', 'after')}>
                {insertLabel(tm.insertColumnRight, tm.insertColumnsRight, cols)}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          {!wholeCols && (
            <ContextMenuItem onSelect={() => controller.deleteDims('row')}>
              {rows > 1 ? format(tm.deleteRowsCount, { from: range.r1 + 1, to: range.r2 + 1 }) : tm.deleteRows}
            </ContextMenuItem>
          )}
          {!wholeRows && (
            <ContextMenuItem onSelect={() => controller.deleteDims('col')}>
              {cols > 1 ? format(tm.deleteColumnsCount, { from: colToLetters(range.c1), to: colToLetters(range.c2) }) : tm.deleteColumns}
            </ContextMenuItem>
          )}
          {wholeRows && (
            <>
              <ContextMenuItem onSelect={() => controller.setHidden('row', true)}>{tm.hideRows}</ContextMenuItem>
              <ContextMenuItem onSelect={() => unhideAround(controller, 'row')}>{tm.unhideRows}</ContextMenuItem>
              <ContextMenuItem onSelect={() => controller.resize('row', controller.selectedIndices('row'), null)}>
                {tm.resizeRows}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => fitToData(controller, 'row', controller.selectedIndices('row'))}>{tm.fitRows}</ContextMenuItem>
            </>
          )}
          {wholeCols && (
            <>
              <ContextMenuItem onSelect={() => controller.setHidden('col', true)}>{tm.hideColumns}</ContextMenuItem>
              <ContextMenuItem onSelect={() => unhideAround(controller, 'col')}>{tm.unhideColumns}</ContextMenuItem>
              <ContextMenuItem onSelect={() => controller.resize('col', controller.selectedIndices('col'), null)}>
                {tm.resizeColumns}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => fitToData(controller, 'col', controller.selectedIndices('col'))}>{tm.fitColumns}</ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => controller.clearContents()}>
            {tm.clearContents}
            <ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {commentItem}
          <ContextMenuItem onSelect={() => controller.openPanel('formats')}>{t.weldsheets.data.conditionalFormatting}</ContextMenuItem>
          <ContextMenuItem onSelect={() => controller.openPanel('validation')}>{t.weldsheets.data.dataValidation}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => insertChart(controller)}>{t.weldsheets.charts.insert}</ContextMenuItem>
          {onCreatePivot && <ContextMenuItem onSelect={onCreatePivot}>{t.weldsheets.pivot.create}</ContextMenuItem>}
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

/** Unhides hidden rows/columns inside the selection, plus the ones right next to it. */
function unhideAround(controller: SheetController, axis: 'row' | 'col'): void {
  const indices = controller.selectedIndices(axis);
  if (indices.length === 0) return;
  const dims = axis === 'row' ? controller.sheet.rows : controller.sheet.cols;
  const lo = indices[0]!;
  const hi = indices[indices.length - 1]!;
  const hidden: number[] = [];
  for (let i = lo; i <= hi; i++) if (dims.isHidden(i)) hidden.push(i);
  for (let i = lo - 1; i >= 0 && dims.isHidden(i); i--) hidden.push(i);
  for (let i = hi + 1; dims.isHidden(i); i++) hidden.push(i);
  if (hidden.length) controller.apply({ type: 'hideDims', sheetId: controller.activeSheetId, axis, indices: hidden, hidden: false });
}

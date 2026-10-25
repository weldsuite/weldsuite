import { MAX_COLS, MAX_ROWS } from '@weldsuite/sheets-engine';
import { cellSelection, wholeColumns, wholeRows } from './selection';
import type { SheetController } from './sheet-controller';

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * Keys while the grid has focus and no cell is being edited. Returns true when
 * the key was handled (the caller then prevents the browser default).
 * `pageRows` is how many rows a PageUp/PageDown moves.
 */
export function handleGridKey(ctl: SheetController, e: KeyInput, pageRows: number): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const arrow = ARROWS[e.key];
  if (arrow) {
    ctl.move(arrow[0], arrow[1], { extend: e.shiftKey, jump: mod });
    return true;
  }
  if (mod) return handleModKey(ctl, e);
  return handlePlainKey(ctl, e, pageRows);
}

function handleModKey(ctl: SheetController, e: KeyInput): boolean {
  switch (e.key.toLowerCase()) {
    case 'z':
      if (e.shiftKey) ctl.redo();
      else ctl.undo();
      return true;
    case 'y':
      ctl.redo();
      return true;
    case 'b':
      ctl.toggle('bold');
      return true;
    case 'i':
      ctl.toggle('italic');
      return true;
    case 'u':
      ctl.toggle('underline');
      return true;
    case 'a':
      ctl.select({ ranges: [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }], active: ctl.selection.active, anchor: ctl.selection.active });
      return true;
    case 'home':
      ctl.select(cellSelection(0, 0));
      return true;
    case 'end':
      goToLastCell(ctl);
      return true;
    case ' ':
      selectWholeColumns(ctl);
      return true;
    default:
      return false;
  }
}

function handlePlainKey(ctl: SheetController, e: KeyInput, pageRows: number): boolean {
  switch (e.key) {
    case 'Enter':
      if (e.shiftKey) ctl.advance(-1, 0);
      else ctl.beginEdit();
      return true;
    case 'F2':
      ctl.beginEdit();
      return true;
    case 'Tab':
      ctl.advance(0, e.shiftKey ? -1 : 1);
      return true;
    case 'Delete':
    case 'Backspace':
      ctl.clearContents();
      return true;
    case 'Home':
      ctl.select(cellSelection(ctl.selection.active.row, 0));
      return true;
    case 'PageDown':
      ctl.move(pageRows, 0, { extend: e.shiftKey });
      return true;
    case 'PageUp':
      ctl.move(-pageRows, 0, { extend: e.shiftKey });
      return true;
    case ' ': {
      if (e.shiftKey) {
        selectWholeRows(ctl);
        return true;
      }
      // Space ticks a checkbox cell instead of starting to type.
      const { row, col } = ctl.selection.active;
      if (ctl.validationAt(row, col)?.criteria.type !== 'checkbox') return false;
      ctl.toggleCheckbox(row, col);
      return true;
    }
    default:
      return false;
  }
}

function goToLastCell(ctl: SheetController): void {
  const used = ctl.engine.usedRange(ctl.activeSheetId);
  ctl.select(cellSelection(used?.r2 ?? 0, used?.c2 ?? 0));
}

function selectWholeColumns(ctl: SheetController): void {
  const { active } = ctl.selection;
  ctl.select({ ranges: [wholeColumns(active.col, active.col)], active, anchor: active });
}

function selectWholeRows(ctl: SheetController): void {
  const { active } = ctl.selection;
  ctl.select({ ranges: [wholeRows(active.row, active.row)], active, anchor: active });
}

/**
 * Keys while a cell is being edited. Returns true when handled. `inReplace`
 * arrows commit and move, as when typing over a cell in any spreadsheet.
 */
export function handleEditKey(ctl: SheetController, e: KeyInput): boolean {
  const edit = ctl.editing;
  if (!edit) return false;
  if (e.key === 'Escape') {
    ctl.cancelEdit();
    return true;
  }
  if (e.key === 'Enter' && !e.altKey) {
    if (e.ctrlKey || e.metaKey) {
      ctl.fillSelection(edit.text);
      return true;
    }
    const step = e.shiftKey ? -1 : 1;
    return commitThen(ctl, () => ctl.advance(step, 0));
  }
  if (e.key === 'Tab') {
    const step = e.shiftKey ? -1 : 1;
    return commitThen(ctl, () => ctl.advance(0, step));
  }
  const arrow = ARROWS[e.key];
  if (arrow && edit.replace && !edit.text.startsWith('=')) return commitThen(ctl, () => ctl.move(arrow[0], arrow[1]));
  return false;
}

/** Commits the edit, then moves on; an edit a validation rule refused stays open where it is. */
function commitThen(ctl: SheetController, move: () => void): true {
  if (ctl.commitEdit()) move();
  return true;
}

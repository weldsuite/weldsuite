import { isError, type ErrorCode } from '@weldsuite/sheets-engine';
import type { SheetController } from './sheet-controller';

/** The words a cell hint is written in (`weldsheets.cellHints`). */
export interface CellHintStrings {
  invalid: string;
  invalidList: string;
  /** A formula that doesn't parse (not a missing name). */
  parseError: string;
  errors: Record<ErrorCode, string>;
}

const PARSE_ERROR = 'Formula parse error';

/**
 * What to tell someone hovering a cell with a problem: why a formula
 * errored, or why its value breaks the validation rule (the rule's own help
 * text first). Null when the cell is fine.
 */
export function cellHint(ctl: SheetController, row: number, col: number, strings: CellHintStrings): string | null {
  const value = ctl.engine.getValue(ctl.activeSheetId, row, col);
  if (value === null) return null;
  if (isError(value)) {
    // The engine reports a formula it can't read as #NAME? with this message.
    if (value.message?.startsWith(PARSE_ERROR)) return strings.parseError;
    const reason = strings.errors[value.code];
    return value.message ? `${reason} (${value.message})` : reason;
  }
  if (!ctl.isInvalid(row, col)) return null;
  const rule = ctl.validationAt(row, col);
  if (rule?.help) return rule.help;
  return rule?.criteria.type === 'list' || rule?.criteria.type === 'listRange' ? strings.invalidList : strings.invalid;
}

/** The selected cell whose hint shows without the pointer: only when exactly one cell (or one merged cell) is selected. */
export function selectedHintCell(ctl: SheetController): { row: number; col: number } | null {
  const { ranges, active } = ctl.selection;
  const only = ranges.length === 1 ? ranges[0]! : null;
  if (!only) return null;
  const cell = ctl.sheet.mergeAt(active.row, active.col) ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col };
  const same = only.r1 === cell.r1 && only.c1 === cell.c1 && only.r2 === cell.r2 && only.c2 === cell.c2;
  return same ? active : null;
}

import { formatValue, localizeFormula } from '@weldsuite/sheets-engine';
import type { SheetController } from './sheet-controller';

export interface FindOptions {
  matchCase: boolean;
  /** The whole cell must match, not just part of it. */
  wholeCell: boolean;
  /** Formulas are searched as written ("=SUM(A1:A3)"), not by their results. */
  formulas: boolean;
  /** Every sheet, starting with the active one; otherwise only the active one. */
  allSheets: boolean;
}

export interface FindMatch {
  sheetId: string;
  row: number;
  col: number;
}

/** Cells looked at per search; a bigger workbook is searched only that far. */
const SCAN_LIMIT = 500_000;

function pattern(query: string, opts: FindOptions): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(opts.wholeCell ? `^${escaped}$` : escaped, opts.matchCase ? 'g' : 'gi');
}

/**
 * The text a search looks at in a cell: its formula when searching formulas,
 * else what it shows. `forReplace`: the text a replace would rewrite instead
 * (a value as typed, "1234.5" for "1,234.50"; no formula unless searching
 * formulas), so every match counted can be replaced.
 */
function searchedText(ctl: SheetController, sheetId: string, row: number, col: number, opts: FindOptions, forReplace: boolean): string | null {
  const cell = ctl.engine.getCell(sheetId, row, col);
  if (!cell) return null;
  if (cell.f !== undefined && opts.formulas) return `=${localizeFormula(cell.f, ctl.options.formulaLocale)}`;
  if (forReplace) return cell.f === undefined ? ctl.inputText(row, col, sheetId) || null : null;
  const value = ctl.engine.getValue(sheetId, row, col);
  if (value === null) return null;
  const sheet = ctl.engine.workbook.getSheet(sheetId)!;
  return formatValue(value, ctl.engine.workbook.style(sheet, row, col)?.numFmt, ctl.options.locale).text;
}

/**
 * The cells whose text contains (or is) `query`, sheet by sheet (the active
 * one first), row by row. `forReplace` (the bar is replacing): only cells a
 * replace can change, matched on the text it rewrites.
 */
export function findMatches(ctl: SheetController, query: string, opts: FindOptions, forReplace = false): FindMatch[] {
  if (!query) return [];
  const re = pattern(query, opts);
  const sheets = ctl.engine.workbook.sheets;
  const active = sheets.findIndex((s) => s.id === ctl.activeSheetId);
  const order = opts.allSheets ? [...sheets.slice(active), ...sheets.slice(0, active)] : sheets.slice(active, active + 1);
  const out: FindMatch[] = [];
  let seen = 0;
  for (const sheet of order) {
    const found: FindMatch[] = [];
    sheet.cells.forEachInRange({ r1: 0, c1: 0, r2: sheet.rowCount - 1, c2: sheet.colCount - 1 }, (row, col) => {
      if (++seen > SCAN_LIMIT) return;
      const text = searchedText(ctl, sheet.id, row, col, opts, forReplace);
      re.lastIndex = 0;
      if (text !== null && re.test(text)) found.push({ sheetId: sheet.id, row, col });
    });
    found.sort((a, b) => a.row - b.row || a.col - b.col);
    out.push(...found);
  }
  return out;
}

/**
 * Replaces `query` in the matched cells, as one change that undoes at once.
 * Values are replaced in what was typed (the input text), formulas only when
 * searching formulas. Returns how many cells changed.
 */
export function replaceMatches(ctl: SheetController, matches: FindMatch[], query: string, replacement: string, opts: FindOptions): number {
  if (ctl.readOnly || !query) return 0;
  const re = pattern(query, opts);
  const entries: { sheetId: string; row: number; col: number; text: string }[] = [];
  for (const m of matches) {
    const cell = ctl.engine.getCell(m.sheetId, m.row, m.col);
    if (!cell || (cell.f !== undefined && !opts.formulas)) continue;
    const before = ctl.inputText(m.row, m.col, m.sheetId);
    re.lastIndex = 0;
    const after = before.replace(re, () => replacement);
    if (after !== before) entries.push({ ...m, text: after });
  }
  ctl.setInputs(entries);
  return entries.length;
}

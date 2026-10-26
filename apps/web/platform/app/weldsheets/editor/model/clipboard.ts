import {
  delocalizeFormula,
  parseInput,
  rewriteRefs,
  translateFormula,
  type CellContent,
  type CellPatch,
  type Op,
  type Range,
  type Scalar,
  type Workbook,
} from '@weldsuite/sheets-engine';
import { clampToGrid, primaryRange } from './selection';
import type { SheetController } from './sheet-controller';

/** What a copy remembers so a paste inside WeldSheets keeps formulas and formatting. */
interface InternalClip {
  text: string;
  /** The spreadsheet copied from: a cut only moves cells within it. */
  workbook: Workbook;
  sheetId: string;
  range: Range;
  cells: { content: CellContent | null; style: string | null; value: Scalar }[][];
  cut: boolean;
}

let lastCopy: InternalClip | null = null;

export interface ClipboardPayload {
  text: string;
  html: string;
}

/** Copies (or cuts) the primary selection range. */
export function copySelection(ctl: SheetController, cut = false): ClipboardPayload {
  const sheet = ctl.sheet;
  const used = ctl.engine.usedRange(sheet.id);
  let range = clampToGrid(primaryRange(ctl.selection), sheet.rowCount, sheet.colCount);
  if (used) range = { ...range, r2: Math.min(range.r2, Math.max(used.r2, range.r1)), c2: Math.min(range.c2, Math.max(used.c2, range.c1)) };
  const clip = readClip(ctl, range, cut);
  lastCopy = clip;
  return { text: clip.text, html: clip.html };
}

/** A range of the active sheet as a copy holds it: displayed text and HTML, contents, styles and values. */
function readClip(ctl: SheetController, range: Range, cut: boolean): InternalClip & { html: string } {
  const sheet = ctl.sheet;
  const lines: string[] = [];
  const htmlRows: string[] = [];
  const cells: InternalClip['cells'] = [];
  for (let row = range.r1; row <= range.r2; row++) {
    const texts: string[] = [];
    const tds: string[] = [];
    const clipRow: InternalClip['cells'][number] = [];
    for (let col = range.c1; col <= range.c2; col++) {
      const display = ctl.displayText(row, col).text;
      texts.push(tsvField(display));
      tds.push(`<td>${escapeHtml(display)}</td>`);
      const cell = sheet.cells.get(row, col);
      clipRow.push({ content: contentOf(cell), style: cell?.s ?? null, value: ctl.engine.getValue(sheet.id, row, col) });
    }
    lines.push(texts.join('\t'));
    htmlRows.push(`<tr>${tds.join('')}</tr>`);
    cells.push(clipRow);
  }
  const text = lines.join('\n');
  return { text, html: `<table>${htmlRows.join('')}</table>`, workbook: ctl.engine.workbook, sheetId: sheet.id, range, cells, cut };
}

/**
 * Drops a block of cells dragged by its border at (top, left): moved (its
 * place emptied, formulas unchanged) or, with `copy`, copied (formulas move
 * relatively), contents and formatting both. The block is selected where it lands.
 */
export function moveCells(ctl: SheetController, source: Range, top: number, left: number, copy: boolean): void {
  if (top === source.r1 && left === source.c1) return;
  const clip = readClip(ctl, source, !copy);
  const target = { r1: top, c1: left, r2: top + source.r2 - source.r1, c2: left + source.c2 - source.c1 };
  ctl.apply(internalPaste(ctl, clip, top, left, target, false));
  const active = { row: top + ctl.selection.active.row - source.r1, col: left + ctl.selection.active.col - source.c1 };
  ctl.select({ ranges: [target], active, anchor: { row: top, col: left } });
}

function contentOf(cell: { v: unknown; f?: string } | undefined): CellContent | null {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  return cell.v === null ? null : ({ v: cell.v } as CellContent);
}

function tsvField(s: string): string {
  return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pastes clipboard contents at the selection. `valuesOnly` (Ctrl+Shift+V)
 * pastes what cells show, without formulas or formatting.
 */
export function pasteInto(ctl: SheetController, text: string, html: string | null, valuesOnly = false): void {
  const target = primaryRange(ctl.selection);
  const origin = ctl.selection.active;
  const top = Math.min(target.r1, origin.row);
  const left = Math.min(target.c1, origin.col);
  const internal = matchingClip(ctl, text);
  const grid = (html ? parseHtmlTable(html) : null) ?? parseTsv(text);
  const op = internal ? internalPaste(ctl, internal, top, left, target, valuesOnly) : externalPaste(ctl, grid, top, left);
  if (!op) return;
  ctl.apply(op);
  const rows = internal ? internal.cells.length : 1;
  const cols = internal ? (internal.cells[0]?.length ?? 1) : 1;
  ctl.select({
    ranges: [{ r1: top, c1: left, r2: Math.max(top + rows - 1, target.r2), c2: Math.max(left + cols - 1, target.c2) }],
    active: { row: top, col: left },
    anchor: { row: top, col: left },
  });
  if (internal?.cut && !valuesOnly) lastCopy = null;
}

/**
 * The remembered copy, when the pasted text is what it put on the clipboard. A
 * cut whose source is no longer here (another spreadsheet, or a deleted tab)
 * pastes as a copy: there is nothing left to clear.
 */
function matchingClip(ctl: SheetController, text: string): InternalClip | null {
  if (!lastCopy || normalizeNewlines(lastCopy.text) !== normalizeNewlines(text)) return null;
  const sourceHere = lastCopy.workbook === ctl.engine.workbook && !!ctl.engine.workbook.getSheet(lastCopy.sheetId);
  return lastCopy.cut && !sourceHere ? { ...lastCopy, cut: false } : lastCopy;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

/**
 * Formulas move relatively; a single copied cell fills the whole target
 * selection. Values only: what the cells showed, no formulas or styles, and
 * a cut leaves its source.
 */
function internalPaste(ctl: SheetController, clip: InternalClip, top: number, left: number, target: Range, valuesOnly: boolean): Op {
  const sheetId = ctl.activeSheetId;
  const height = clip.cells.length;
  const width = clip.cells[0]?.length ?? 0;
  const fill = height === 1 && width === 1;
  const r2 = fill ? target.r2 : top + height - 1;
  const c2 = fill ? target.c2 : left + width - 1;
  const contents: CellPatch[] = [];
  const styles: [number, number, string | null][] = [];
  // A cut within one sheet moves cells: references to them follow.
  const move = clip.cut && !valuesOnly && clip.sheetId === sheetId ? { range: clip.range, dRow: top - clip.range.r1, dCol: left - clip.range.c1 } : null;
  for (let row = top; row <= Math.min(r2, ctl.sheet.rowCount - 1); row++) {
    for (let col = left; col <= Math.min(c2, ctl.sheet.colCount - 1); col++) {
      const src = clip.cells[(row - top) % height]![(col - left) % width]!;
      const srcRow = clip.range.r1 + ((row - top) % height);
      const srcCol = clip.range.c1 + ((col - left) % width);
      let content = src.content;
      if (valuesOnly) content = src.value === null ? null : { v: src.value };
      else if (content?.f !== undefined && move) content = { f: followMove(content.f, ctl.sheet.name, ctl.sheet.name, move) };
      else if (content?.f !== undefined && !clip.cut) content = { f: translateFormula(content.f, row - srcRow, col - srcCol) };
      contents.push([row, col, content]);
      styles.push([row, col, src.style]);
    }
  }
  if (valuesOnly) return { type: 'setCells', sheetId, cells: contents };
  const ops: Op[] = [];
  if (clip.cut) ops.push(clearSource(ctl, clip));
  ops.push({ type: 'setCells', sheetId, cells: contents }, { type: 'setStyles', sheetId, cells: styles });
  if (move) ops.push(...readersFollow(ctl, move, { r1: top, c1: left, r2, c2 }));
  return { type: 'batch', ops };
}

interface Move {
  range: Range;
  dRow: number;
  dCol: number;
}

/**
 * A formula with its references to cells inside a moved block (on the
 * active sheet) moved with them, as Excel does when cells are cut and pasted
 * or dragged. References only partly inside, or to whole rows or columns, stay.
 */
function followMove(formula: string, hostSheet: string, movedSheet: string, move: Move): string {
  const { range: r, dRow, dCol } = move;
  return rewriteRefs(formula, (ref) => {
    if ((ref.sheet ?? hostSheet).toLowerCase() !== movedSheet.toLowerCase()) return undefined;
    if (ref.kind !== 'cell' && ref.kind !== 'range') return undefined;
    if (ref.r1 < r.r1 || ref.r2 > r.r2 || ref.c1 < r.c1 || ref.c2 > r.c2) return undefined;
    return { ...ref, r1: ref.r1 + dRow, r2: ref.r2 + dRow, c1: ref.c1 + dCol, c2: ref.c2 + dCol };
  });
}

/** The other formulas of the workbook that read moved cells, rewritten to read them where they went. */
function readersFollow(ctl: SheetController, move: Move, target: Range): Op[] {
  const movedSheet = ctl.sheet.name;
  const inside = (r: Range, row: number, col: number) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
  const ops: Op[] = [];
  for (const sheet of ctl.engine.workbook.sheets) {
    const own = sheet.id === ctl.activeSheetId;
    const cells: CellPatch[] = [];
    sheet.cells.forEachInRange({ r1: 0, c1: 0, r2: sheet.rowCount - 1, c2: sheet.colCount - 1 }, (row, col, cell) => {
      if (cell.f === undefined || (own && (inside(move.range, row, col) || inside(target, row, col)))) return;
      const f = followMove(cell.f, sheet.name, movedSheet, move);
      if (f !== cell.f) cells.push([row, col, { f }]);
    });
    if (cells.length) ops.push({ type: 'setCells', sheetId: sheet.id, cells });
  }
  return ops;
}

/** A cut empties its source first (the paste then fills the target). */
function clearSource(ctl: SheetController, clip: InternalClip): Op {
  const cells: CellPatch[] = [];
  const styles: [number, number, string | null][] = [];
  const sheet = ctl.engine.workbook.getSheet(clip.sheetId);
  sheet?.cells.forEachInRange(clip.range, (row, col) => {
    cells.push([row, col, null]);
    styles.push([row, col, null]);
  });
  return {
    type: 'batch',
    ops: [
      { type: 'setCells', sheetId: clip.sheetId, cells },
      { type: 'setStyles', sheetId: clip.sheetId, cells: styles },
    ],
  };
}

function externalPaste(ctl: SheetController, grid: string[][], top: number, left: number): Op | null {
  if (grid.length === 0) return null;
  const cells: CellPatch[] = [];
  const formats: Op[] = [];
  grid.forEach((line, i) => {
    line.forEach((raw, j) => {
      const row = top + i;
      const col = left + j;
      if (row >= ctl.sheet.rowCount || col >= ctl.sheet.colCount) return;
      const parsed = parseInput(raw, { locale: ctl.options.locale });
      if (parsed.kind === 'formula') {
        cells.push([row, col, { f: delocalizeFormula(parsed.formula, ctl.options.formulaLocale) }]);
        return;
      }
      cells.push([row, col, parsed.value === null ? null : { v: parsed.value }]);
      if (parsed.numFmt) {
        formats.push({ type: 'formatRanges', sheetId: ctl.activeSheetId, ranges: [{ r1: row, c1: col, r2: row, c2: col }], patch: { numFmt: parsed.numFmt } });
      }
    });
  });
  return { type: 'batch', ops: [{ type: 'setCells', sheetId: ctl.activeSheetId, cells }, ...formats] };
}

/** Tab-separated text, with quoted fields that may hold tabs, newlines and "" escapes. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const s = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (s === '') return [];
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '"' && field === '') {
      const end = readQuoted(s, i);
      field = end.value;
      i = end.next;
      continue;
    }
    if (ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function readQuoted(s: string, start: number): { value: string; next: number } {
  let value = '';
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') {
        value += '"';
        i += 2;
        continue;
      }
      return { value, next: i + 1 };
    }
    value += s[i];
    i++;
  }
  return { value, next: i };
}

/** The first <table> of pasted HTML (Excel, Google Sheets, web pages), as text cells. */
export function parseHtmlTable(html: string): string[][] | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const out: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const row: string[] = [];
    for (const td of Array.from(tr.querySelectorAll('td,th'))) {
      row.push((td.textContent ?? '').replace(/\u00a0/g, ' ').trim());
      const span = Number(td.getAttribute('colspan') ?? 1);
      for (let k = 1; k < span; k++) row.push('');
    }
    out.push(row);
  }
  return out.length ? out : null;
}

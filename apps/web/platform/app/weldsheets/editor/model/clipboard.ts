import {
  delocalizeFormula,
  parseInput,
  translateFormula,
  type CellContent,
  type CellPatch,
  type Op,
  type Range,
} from '@weldsuite/sheets-engine';
import { clampToGrid, primaryRange } from './selection';
import type { SheetController } from './sheet-controller';

/** What a copy remembers so a paste inside WeldSheets keeps formulas and formatting. */
interface InternalClip {
  text: string;
  sheetId: string;
  range: Range;
  cells: { content: CellContent | null; style: string | null }[][];
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
      clipRow.push({ content: contentOf(cell), style: cell?.s ?? null });
    }
    lines.push(texts.join('\t'));
    htmlRows.push(`<tr>${tds.join('')}</tr>`);
    cells.push(clipRow);
  }
  const text = lines.join('\n');
  lastCopy = { text, sheetId: sheet.id, range, cells, cut };
  return { text, html: `<table>${htmlRows.join('')}</table>` };
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

/** Pastes clipboard contents at the selection. */
export function pasteInto(ctl: SheetController, text: string, html: string | null): void {
  const target = primaryRange(ctl.selection);
  const origin = ctl.selection.active;
  const top = Math.min(target.r1, origin.row);
  const left = Math.min(target.c1, origin.col);
  const internal = lastCopy && normalizeNewlines(lastCopy.text) === normalizeNewlines(text) ? lastCopy : null;
  const grid = (html ? parseHtmlTable(html) : null) ?? parseTsv(text);
  const op = internal ? internalPaste(ctl, internal, top, left, target) : externalPaste(ctl, grid, top, left);
  if (!op) return;
  ctl.apply(op);
  const rows = internal ? internal.cells.length : 1;
  const cols = internal ? (internal.cells[0]?.length ?? 1) : 1;
  ctl.select({
    ranges: [{ r1: top, c1: left, r2: Math.max(top + rows - 1, target.r2), c2: Math.max(left + cols - 1, target.c2) }],
    active: { row: top, col: left },
    anchor: { row: top, col: left },
  });
  if (internal?.cut) lastCopy = null;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

/** Formulas move relatively; a single copied cell fills the whole target selection. */
function internalPaste(ctl: SheetController, clip: InternalClip, top: number, left: number, target: Range): Op {
  const sheetId = ctl.activeSheetId;
  const height = clip.cells.length;
  const width = clip.cells[0]?.length ?? 0;
  const fill = height === 1 && width === 1;
  const r2 = fill ? target.r2 : top + height - 1;
  const c2 = fill ? target.c2 : left + width - 1;
  const contents: CellPatch[] = [];
  const styles: [number, number, string | null][] = [];
  for (let row = top; row <= Math.min(r2, ctl.sheet.rowCount - 1); row++) {
    for (let col = left; col <= Math.min(c2, ctl.sheet.colCount - 1); col++) {
      const src = clip.cells[(row - top) % height]![(col - left) % width]!;
      const srcRow = clip.range.r1 + ((row - top) % height);
      const srcCol = clip.range.c1 + ((col - left) % width);
      let content = src.content;
      if (content?.f !== undefined && !clip.cut) content = { f: translateFormula(content.f, row - srcRow, col - srcCol) };
      contents.push([row, col, content]);
      styles.push([row, col, src.style]);
    }
  }
  const ops: Op[] = [];
  if (clip.cut) ops.push(clearSource(ctl, clip));
  ops.push({ type: 'setCells', sheetId, cells: contents }, { type: 'setStyles', sheetId, cells: styles });
  return { type: 'batch', ops };
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

/**
 * Cell addressing. Rows and columns are 0-based everywhere in the engine;
 * A1 text is 1-based only at the edges.
 */

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

export interface CellAddress {
  row: number;
  col: number;
}

/** Inclusive, normalised (r1 <= r2, c1 <= c2). */
export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function colToLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 'A' → 0, 'AA' → 26. Returns -1 for anything that is not 1–3 letters in range. */
export function lettersToCol(letters: string): number {
  if (letters.length === 0 || letters.length > 3) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i) & ~32; // upper-case
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

export function formatA1(row: number, col: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

export function formatRange(r: Range): string {
  if (r.r1 === r.r2 && r.c1 === r.c2) return formatA1(r.r1, r.c1);
  if (r.r1 === 0 && r.r2 === MAX_ROWS - 1) return `${colToLetters(r.c1)}:${colToLetters(r.c2)}`;
  if (r.c1 === 0 && r.c2 === MAX_COLS - 1) return `${r.r1 + 1}:${r.r2 + 1}`;
  return `${formatA1(r.r1, r.c1)}:${formatA1(r.r2, r.c2)}`;
}

const A1_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseA1(text: string): CellAddress | null {
  const m = A1_RE.exec(text.trim());
  if (!m) return null;
  const col = lettersToCol(m[1]!);
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col };
}

/** 'A1', 'A1:B2', 'A:C', '2:5' (no sheet prefix). */
export function parseRange(text: string): Range | null {
  const t = text.trim().replace(/\$/g, '');
  const parts = t.split(':');
  if (parts.length === 1) {
    const a = parseA1(t);
    return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null;
  }
  if (parts.length !== 2) return null;
  const [p, q] = parts as [string, string];
  const a = parseA1(p);
  const b = parseA1(q);
  if (a && b) return normalizeRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
  if (/^[A-Za-z]{1,3}$/.test(p) && /^[A-Za-z]{1,3}$/.test(q)) {
    const c1 = lettersToCol(p);
    const c2 = lettersToCol(q);
    if (c1 < 0 || c2 < 0) return null;
    return normalizeRange({ r1: 0, c1, r2: MAX_ROWS - 1, c2 });
  }
  if (/^\d+$/.test(p) && /^\d+$/.test(q)) {
    const r1 = Number(p) - 1;
    const r2 = Number(q) - 1;
    if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) return null;
    return normalizeRange({ r1, c1: 0, r2, c2: MAX_COLS - 1 });
  }
  return null;
}

export function normalizeRange(r: Range): Range {
  return {
    r1: Math.min(r.r1, r.r2),
    c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2),
    c2: Math.max(r.c1, r.c2),
  };
}

export function rangeContains(r: Range, row: number, col: number): boolean {
  return row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
}

export function rangesIntersect(a: Range, b: Range): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function rangeIntersection(a: Range, b: Range): Range | null {
  if (!rangesIntersect(a, b)) return null;
  return {
    r1: Math.max(a.r1, b.r1),
    c1: Math.max(a.c1, b.c1),
    r2: Math.min(a.r2, b.r2),
    c2: Math.min(a.c2, b.c2),
  };
}

export function rangeSize(r: Range): { rows: number; cols: number } {
  return { rows: r.r2 - r.r1 + 1, cols: r.c2 - r.c1 + 1 };
}

/** Sheet names that need quoting in a formula: anything but a plain identifier. */
export function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseA1(name) && !/^(TRUE|FALSE)$/i.test(name)) {
    return name;
  }
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Numeric key for (row, col), unique per sheet. Fits well inside a safe
 * integer: row < 2^20, col < 2^14.
 */
export function cellKey(row: number, col: number): number {
  return row * MAX_COLS + col;
}

export function keyRow(key: number): number {
  return Math.floor(key / MAX_COLS);
}

export function keyCol(key: number): number {
  return key % MAX_COLS;
}

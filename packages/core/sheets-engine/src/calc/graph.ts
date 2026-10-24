/**
 * Dependency graph: which formulas read which cells.
 *
 * Formula cells and positions are numeric keys (see `globalKey`). Precedents
 * come in two kinds:
 *
 * - single cells, kept in a point index (cell → formulas);
 * - ranges, deduplicated by shape (ten thousand =COUNTIF(A:A, …) formulas
 *   share one A:A entry) and bucketed spatially. A range that would span too
 *   many buckets (whole columns, big blocks) goes to a short per-sheet list
 *   that is checked on every query instead.
 */

import { MAX_COLS, MAX_ROWS, type Range } from '../address';

/** Rows × columns per sheet; a sheet number times this offsets every cell key. */
export const SHEET_STRIDE = MAX_ROWS * MAX_COLS;

export function globalKey(sheet: number, row: number, col: number): number {
  return sheet * SHEET_STRIDE + row * MAX_COLS + col;
}

export function splitKey(key: number): { sheet: number; row: number; col: number } {
  const sheet = Math.floor(key / SHEET_STRIDE);
  const rest = key - sheet * SHEET_STRIDE;
  return { sheet, row: Math.floor(rest / MAX_COLS), col: rest % MAX_COLS };
}

export interface Precedent extends Range {
  sheet: number;
}

interface RangeEntry extends Range {
  key: string;
  dependents: Set<number>;
  /** Bucket keys this entry is filed under; empty for large ranges. */
  buckets: number[];
}

const BUCKET_ROW_BITS = 8;
const BUCKET_COL_BITS = 4;
const BUCKET_COLS = MAX_COLS >> BUCKET_COL_BITS;
const MAX_BUCKETS_PER_RANGE = 256;

class SheetRangeIndex {
  readonly entries = new Map<string, RangeEntry>();
  private readonly buckets = new Map<number, Set<RangeEntry>>();
  private readonly large = new Set<RangeEntry>();

  add(r: Range, dependent: number): void {
    const key = `${r.r1}:${r.c1}:${r.r2}:${r.c2}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { ...r, key, dependents: new Set(), buckets: [] };
      this.entries.set(key, entry);
      this.file(entry);
    }
    entry.dependents.add(dependent);
  }

  /** Files a new entry under every bucket it overlaps, or as large when that is too many. */
  private file(entry: RangeEntry): void {
    const br1 = entry.r1 >> BUCKET_ROW_BITS;
    const br2 = entry.r2 >> BUCKET_ROW_BITS;
    const bc1 = entry.c1 >> BUCKET_COL_BITS;
    const bc2 = entry.c2 >> BUCKET_COL_BITS;
    if ((br2 - br1 + 1) * (bc2 - bc1 + 1) > MAX_BUCKETS_PER_RANGE) {
      this.large.add(entry);
      return;
    }
    for (let br = br1; br <= br2; br++) {
      for (let bc = bc1; bc <= bc2; bc++) {
        const bk = br * BUCKET_COLS + bc;
        let set = this.buckets.get(bk);
        if (!set) {
          set = new Set();
          this.buckets.set(bk, set);
        }
        set.add(entry);
        entry.buckets.push(bk);
      }
    }
  }

  remove(r: Range, dependent: number): void {
    const key = `${r.r1}:${r.c1}:${r.r2}:${r.c2}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.dependents.delete(dependent);
    if (entry.dependents.size > 0) return;
    this.entries.delete(key);
    this.large.delete(entry);
    for (const bk of entry.buckets) {
      const set = this.buckets.get(bk);
      set?.delete(entry);
      if (set?.size === 0) this.buckets.delete(bk);
    }
  }

  /** Dependents of every range containing (row, col). */
  queryPoint(row: number, col: number, out: (key: number) => void): void {
    const set = this.buckets.get((row >> BUCKET_ROW_BITS) * BUCKET_COLS + (col >> BUCKET_COL_BITS));
    if (set) {
      for (const e of set) {
        if (row >= e.r1 && row <= e.r2 && col >= e.c1 && col <= e.c2) e.dependents.forEach(out);
      }
    }
    for (const e of this.large) {
      if (row >= e.r1 && row <= e.r2 && col >= e.c1 && col <= e.c2) e.dependents.forEach(out);
    }
  }

  /** Dependents of every range intersecting `r`. */
  queryRange(r: Range, out: (key: number) => void): void {
    for (const e of this.entries.values()) {
      if (e.r1 <= r.r2 && r.r1 <= e.r2 && e.c1 <= r.c2 && r.c1 <= e.c2) e.dependents.forEach(out);
    }
  }
}

export class DependencyGraph {
  private readonly precedents = new Map<number, Precedent[]>();
  private readonly points = new Map<number, Set<number>>();
  private readonly ranges = new Map<number, SheetRangeIndex>();
  readonly volatile = new Set<number>();

  get formulaCount(): number {
    return this.precedents.size;
  }

  /** Replaces the precedents of formula `key`. */
  setFormula(key: number, precedents: Precedent[], volatile: boolean): void {
    this.removeFormula(key);
    this.precedents.set(key, precedents);
    if (volatile) this.volatile.add(key);
    for (const p of precedents) {
      if (p.r1 === p.r2 && p.c1 === p.c2) {
        const pk = globalKey(p.sheet, p.r1, p.c1);
        let set = this.points.get(pk);
        if (!set) {
          set = new Set();
          this.points.set(pk, set);
        }
        set.add(key);
      } else {
        let idx = this.ranges.get(p.sheet);
        if (!idx) {
          idx = new SheetRangeIndex();
          this.ranges.set(p.sheet, idx);
        }
        idx.add(p, key);
      }
    }
  }

  removeFormula(key: number): void {
    const prev = this.precedents.get(key);
    if (!prev) return;
    this.precedents.delete(key);
    this.volatile.delete(key);
    for (const p of prev) {
      if (p.r1 === p.r2 && p.c1 === p.c2) {
        const pk = globalKey(p.sheet, p.r1, p.c1);
        const set = this.points.get(pk);
        set?.delete(key);
        if (set?.size === 0) this.points.delete(pk);
      } else {
        this.ranges.get(p.sheet)?.remove(p, key);
      }
    }
  }

  hasFormula(key: number): boolean {
    return this.precedents.has(key);
  }

  formulaKeys(): IterableIterator<number> {
    return this.precedents.keys();
  }

  /** Formulas that read cell (sheet, row, col) directly. */
  dependentsOf(sheet: number, row: number, col: number, out: (key: number) => void): void {
    this.points.get(globalKey(sheet, row, col))?.forEach(out);
    this.ranges.get(sheet)?.queryPoint(row, col, out);
  }

  /** Formulas that read any cell of `r` on `sheet`. */
  dependentsOfRange(sheet: number, r: Range, out: (key: number) => void): void {
    const cells = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
    if (cells <= 64) {
      for (let row = r.r1; row <= r.r2; row++) {
        for (let col = r.c1; col <= r.c2; col++) this.points.get(globalKey(sheet, row, col))?.forEach(out);
      }
    } else {
      this.scanPoints(sheet, r, out);
    }
    this.ranges.get(sheet)?.queryRange(r, out);
  }

  /** Point dependents inside a big range: one pass over the points rather than one lookup per cell. */
  private scanPoints(sheet: number, r: Range, out: (key: number) => void): void {
    const lo = globalKey(sheet, 0, 0);
    const hi = lo + SHEET_STRIDE;
    for (const [pk, set] of this.points) {
      if (pk < lo || pk >= hi) continue;
      const { row, col } = splitKey(pk);
      if (row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) set.forEach(out);
    }
  }

  clear(): void {
    this.precedents.clear();
    this.points.clear();
    this.ranges.clear();
    this.volatile.clear();
  }
}

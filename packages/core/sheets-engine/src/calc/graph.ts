/**
 * Dependency graph: which formulas read which cells.
 *
 * Formula cells and positions are numeric keys (see `globalKey`). Precedents
 * come in two kinds:
 *
 * - single cells, kept in a point index (cell → formulas; a cell one formula
 *   reads holds that formula's key, a Set only once a second one reads it);
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

/** No precedents (a formula of constants, or one that does not parse): shared, never written. */
const NO_POINTS: readonly number[] = Object.freeze([]);
const NO_RANGES: readonly Precedent[] = Object.freeze([]);

/**
 * Most cells are read by one formula, so a cell's readers are that formula's
 * key until a second one reads it too.
 */
type Readers = number | Set<number>;

export class DependencyGraph {
  /** Per formula, the cells it reads, as global keys (an array of doubles, no object per cell). */
  private readonly pointPrecedents = new Map<number, readonly number[]>();
  /** Per formula that reads ranges, those ranges. */
  private readonly rangePrecedents = new Map<number, Precedent[]>();
  private readonly points = new Map<number, Readers>();
  private readonly ranges = new Map<number, SheetRangeIndex>();
  readonly volatile = new Set<number>();

  get formulaCount(): number {
    return this.pointPrecedents.size;
  }

  /** Replaces the precedents of formula `key`. */
  setFormula(key: number, precedents: Precedent[], volatile: boolean): void {
    this.removeFormula(key);
    if (volatile) this.volatile.add(key);
    let cells: number[] | null = null;
    let areas: Precedent[] | null = null;
    for (const p of precedents) {
      if (p.r1 === p.r2 && p.c1 === p.c2) {
        const pk = globalKey(p.sheet, p.r1, p.c1);
        cells ??= [];
        cells.push(pk);
        this.addReader(pk, key);
      } else {
        areas ??= [];
        areas.push(p);
        let idx = this.ranges.get(p.sheet);
        if (!idx) {
          idx = new SheetRangeIndex();
          this.ranges.set(p.sheet, idx);
        }
        idx.add(p, key);
      }
    }
    this.pointPrecedents.set(key, cells ?? NO_POINTS);
    if (areas) this.rangePrecedents.set(key, areas);
  }

  removeFormula(key: number): void {
    const cells = this.pointPrecedents.get(key);
    if (!cells) return;
    this.pointPrecedents.delete(key);
    this.volatile.delete(key);
    for (const pk of cells) this.removeReader(pk, key);
    const areas = this.rangePrecedents.get(key);
    if (!areas) return;
    this.rangePrecedents.delete(key);
    for (const p of areas) this.ranges.get(p.sheet)?.remove(p, key);
  }

  private addReader(pk: number, key: number): void {
    const readers = this.points.get(pk);
    if (readers === undefined) this.points.set(pk, key);
    else if (typeof readers === 'number') {
      if (readers !== key) this.points.set(pk, new Set([readers, key]));
    } else readers.add(key);
  }

  private removeReader(pk: number, key: number): void {
    const readers = this.points.get(pk);
    if (readers === undefined) return;
    if (typeof readers === 'number') {
      if (readers === key) this.points.delete(pk);
      return;
    }
    readers.delete(key);
    if (readers.size === 1) this.points.set(pk, readers.values().next().value!);
  }

  /** The cells formula `key` reads, as global keys. */
  pointsOf(key: number): readonly number[] {
    return this.pointPrecedents.get(key) ?? NO_POINTS;
  }

  /** The ranges formula `key` reads. */
  rangesOf(key: number): readonly Precedent[] {
    return this.rangePrecedents.get(key) ?? NO_RANGES;
  }

  hasFormula(key: number): boolean {
    return this.pointPrecedents.has(key);
  }

  formulaKeys(): IterableIterator<number> {
    return this.pointPrecedents.keys();
  }

  /** Formulas that read cell (sheet, row, col) directly. */
  dependentsOf(sheet: number, row: number, col: number, out: (key: number) => void): void {
    emit(this.points.get(globalKey(sheet, row, col)), out);
    this.ranges.get(sheet)?.queryPoint(row, col, out);
  }

  /** Formulas that read any cell of `r` on `sheet`. */
  dependentsOfRange(sheet: number, r: Range, out: (key: number) => void): void {
    const cells = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
    if (cells <= 64) {
      for (let row = r.r1; row <= r.r2; row++) {
        for (let col = r.c1; col <= r.c2; col++) emit(this.points.get(globalKey(sheet, row, col)), out);
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
    for (const [pk, readers] of this.points) {
      if (pk < lo || pk >= hi) continue;
      const { row, col } = splitKey(pk);
      if (row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) emit(readers, out);
    }
  }

  clear(): void {
    this.pointPrecedents.clear();
    this.rangePrecedents.clear();
    this.points.clear();
    this.ranges.clear();
    this.volatile.clear();
  }
}

function emit(readers: Readers | undefined, out: (key: number) => void): void {
  if (readers === undefined) return;
  if (typeof readers === 'number') out(readers);
  else readers.forEach(out);
}

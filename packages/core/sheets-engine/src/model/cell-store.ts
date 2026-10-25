/**
 * Sparse cell storage for one sheet.
 *
 * Cells are grouped in blocks of 256 rows, each a Map keyed by
 * (row-in-block, col). That keeps every Map far below V8's ~16M entry limit
 * at Excel scale and makes row-range scans touch only the blocks they need.
 * Callers only see this class's methods, so the layout can change (columnar
 * typed arrays for very large sheets) without touching them.
 */

import { MAX_COLS, type Range } from '../address';
import type { Scalar } from '../values';

export interface Cell {
  /** The literal value, or the last computed value of a formula. */
  v: Scalar;
  /** Formula source without the leading '='. */
  f?: string;
  /** Style key (see StyleTable). */
  s?: string;
}

const BLOCK_BITS = 8;
const BLOCK_ROWS = 1 << BLOCK_BITS;
const BLOCK_MASK = BLOCK_ROWS - 1;

export class CellStore {
  private readonly blocks = new Map<number, Map<number, Cell>>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  get(row: number, col: number): Cell | undefined {
    return this.blocks.get(row >> BLOCK_BITS)?.get((row & BLOCK_MASK) * MAX_COLS + col);
  }

  set(row: number, col: number, cell: Cell | undefined): void {
    const b = row >> BLOCK_BITS;
    const key = (row & BLOCK_MASK) * MAX_COLS + col;
    let block = this.blocks.get(b);
    if (!cell) {
      if (block?.delete(key)) {
        this.count--;
        if (block.size === 0) this.blocks.delete(b);
      }
      return;
    }
    if (!block) {
      block = new Map();
      this.blocks.set(b, block);
    }
    if (!block.has(key)) this.count++;
    block.set(key, cell);
  }

  /** Visits existing cells inside `range` (unordered within a block). */
  forEachInRange(range: Range, fn: (row: number, col: number, cell: Cell) => void): void {
    const b1 = range.r1 >> BLOCK_BITS;
    const b2 = range.r2 >> BLOCK_BITS;
    const blockCount = b2 - b1 + 1;
    const visit = (b: number, block: Map<number, Cell>) => {
      const base = b << BLOCK_BITS;
      for (const [key, cell] of block) {
        const row = base + Math.floor(key / MAX_COLS);
        const col = key % MAX_COLS;
        if (row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2) fn(row, col, cell);
      }
    };
    if (blockCount > this.blocks.size) {
      for (const [b, block] of this.blocks) if (b >= b1 && b <= b2) visit(b, block);
    } else {
      for (let b = b1; b <= b2; b++) {
        const block = this.blocks.get(b);
        if (block) visit(b, block);
      }
    }
  }

  forEach(fn: (row: number, col: number, cell: Cell) => void): void {
    for (const [b, block] of this.blocks) {
      const base = b << BLOCK_BITS;
      for (const [key, cell] of block) fn(base + Math.floor(key / MAX_COLS), key % MAX_COLS, cell);
    }
  }

  /** Bounding box of all stored cells, or null when empty. */
  usedRange(): Range | null {
    if (this.count === 0) return null;
    let r1 = Infinity;
    let c1 = Infinity;
    let r2 = -1;
    let c2 = -1;
    this.forEach((row, col) => {
      if (row < r1) r1 = row;
      if (row > r2) r2 = row;
      if (col < c1) c1 = col;
      if (col > c2) c2 = col;
    });
    return { r1, c1, r2, c2 };
  }

  /**
   * Re-keys every cell through `map` ((row, col) → new position, or null to
   * drop). Used for row/column insert, delete and move.
   */
  remap(map: (row: number, col: number) => [number, number] | null): void {
    const cells: [number, number, Cell][] = [];
    this.forEach((row, col, cell) => cells.push([row, col, cell]));
    this.blocks.clear();
    this.count = 0;
    for (const [row, col, cell] of cells) {
      const to = map(row, col);
      if (to) this.set(to[0], to[1], cell);
    }
  }

  clear(): void {
    this.blocks.clear();
    this.count = 0;
  }
}

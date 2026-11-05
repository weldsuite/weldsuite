/**
 * A spatial index for viewport culling, hit-testing and marquee selection:
 * a uniform grid hash. Each element is registered in the cells its bounds
 * cover; elements larger than a few dozen cells (big frames) go in a short
 * list checked every time instead.
 *
 * The index is kept up to date incrementally from `Board.takeDirty()`.
 */

import type { Board } from '../model/board';
import type { BoardElement } from '../model/types';
import { elementBounds, elementInRect, hitElement } from './bounds';
import type { Point, Rect } from './path';

const CELL = 512;
const MAX_CELLS = 64;

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly big = new Set<string>();
  private readonly where = new Map<string, { keys: string[]; big: boolean; rect: Rect; bound: string[] }>();
  /** Connectors bound to each element, so moving a shape re-indexes its connectors. */
  private readonly boundBy = new Map<string, Set<string>>();

  constructor(private readonly board: Board) {}

  /** Rebuilds from scratch. */
  rebuild(): void {
    this.cells.clear();
    this.big.clear();
    this.where.clear();
    this.boundBy.clear();
    for (const el of this.board.elements.values()) this.insert(el);
    this.board.takeDirty();
  }

  /** Brings the index up to date with what changed on the board. */
  sync(changed: Iterable<string>): void {
    const ids = new Set(changed);
    // A connector's bounds depend on the elements it is bound to.
    for (const id of [...ids]) for (const c of this.boundBy.get(id) ?? []) ids.add(c);
    for (const id of ids) {
      this.remove(id);
      const el = this.board.get(id);
      if (el) this.insert(el);
    }
  }

  boundsOf(id: string): Rect | undefined {
    return this.where.get(id)?.rect;
  }

  private insert(el: BoardElement): void {
    const r = elementBounds(this.board, el);
    const bound = el.type === 'connector' ? [el.start?.el, el.end?.el].filter((x): x is string => !!x) : [];
    for (const b of bound) {
      let set = this.boundBy.get(b);
      if (!set) this.boundBy.set(b, (set = new Set()));
      set.add(el.id);
    }
    const x0 = Math.floor(r.x / CELL);
    const y0 = Math.floor(r.y / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL);
    const y1 = Math.floor((r.y + r.h) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
      this.big.add(el.id);
      this.where.set(el.id, { keys: [], big: true, rect: r, bound });
      return;
    }
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        let set = this.cells.get(k);
        if (!set) this.cells.set(k, (set = new Set()));
        set.add(el.id);
        keys.push(k);
      }
    }
    this.where.set(el.id, { keys, big: false, rect: r, bound });
  }

  private remove(id: string): void {
    const w = this.where.get(id);
    if (!w) return;
    if (w.big) this.big.delete(id);
    for (const b of w.bound) {
      const set = this.boundBy.get(b);
      set?.delete(id);
      if (set?.size === 0) this.boundBy.delete(b);
    }
    for (const k of w.keys) {
      const set = this.cells.get(k);
      set?.delete(id);
      if (set?.size === 0) this.cells.delete(k);
    }
    this.where.delete(id);
  }

  /** Ids whose bounds meet `r` (a superset of what is visible there). */
  query(r: Rect): Set<string> {
    const out = new Set<string>();
    const x0 = Math.floor(r.x / CELL);
    const y0 = Math.floor(r.y / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL);
    const y1 = Math.floor((r.y + r.h) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      for (const id of this.where.keys()) out.add(id);
      return out;
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const set = this.cells.get(`${x},${y}`);
        if (set) for (const id of set) out.add(id);
      }
    }
    for (const id of this.big) {
      const b = this.where.get(id)!.rect;
      if (b.x <= r.x + r.w && b.x + b.w >= r.x && b.y <= r.y + r.h && b.y + b.h >= r.y) out.add(id);
    }
    return out;
  }

  /**
   * The topmost element under `p`, or null. `skip` leaves elements out (the
   * ones being dragged); `accept` narrows what counts (drop targets).
   */
  hit(p: Point, tolerance: number, skip?: ReadonlySet<string>, accept?: (el: BoardElement) => boolean): BoardElement | null {
    const near = this.query({ x: p.x - tolerance, y: p.y - tolerance, w: tolerance * 2, h: tolerance * 2 });
    if (near.size === 0) return null;
    const order = this.board.paintOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const el = order[i]!;
      if (!near.has(el.id) || skip?.has(el.id)) continue;
      if (accept && !accept(el)) continue;
      if (hitElement(this.board, el, p, tolerance)) return el;
    }
    return null;
  }

  /** Elements in a marquee rectangle (touching, or entirely inside with `contain`), in paint order. */
  inRect(r: Rect, contain = false): BoardElement[] {
    const near = this.query(r);
    return this.board.paintOrder().filter((el) => near.has(el.id) && elementInRect(this.board, el, r, contain));
  }
}

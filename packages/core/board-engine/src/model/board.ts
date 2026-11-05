/**
 * A board: its elements, board properties and the votes of the current
 * voting session. Changed only through ops (ops/apply.ts), so every replica
 * that runs the same ops in the same order holds the same board.
 *
 * Elements are replaced, never mutated: an op that changes an element puts
 * a new object in the map. Renderers can therefore cache per element by
 * object identity.
 */

import { compareOrder } from './order';
import { SNAPSHOT_VERSION, type BoardElement, type BoardProps, type BoardSnapshot } from './types';

export class Board {
  props: BoardProps = {};
  readonly elements = new Map<string, BoardElement>();
  readonly votes = new Map<string, string[]>();
  /** Bumped by every applied op. */
  version = 0;
  /** Bumped when parents or stacking change (paint order must be recomputed). */
  structureVersion = 0;
  /** Elements created, changed or deleted since the last `takeDirty`. */
  private dirty = new Set<string>();
  private paintCache: { version: number; list: BoardElement[] } | null = null;
  private childrenCache: { version: number; map: Map<string | null, BoardElement[]> } | null = null;

  static create(props: BoardProps = {}): Board {
    const board = new Board();
    board.props = structuredClone(props);
    return board;
  }

  static fromSnapshot(snapshot: BoardSnapshot): Board {
    if (snapshot.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported board snapshot version ${snapshot.version}`);
    const board = new Board();
    board.props = structuredClone(snapshot.props);
    for (const el of snapshot.elements) board.elements.set(el.id, structuredClone(el));
    for (const [user, ids] of Object.entries(snapshot.votes ?? {})) board.votes.set(user, [...ids]);
    return board;
  }

  toSnapshot(): BoardSnapshot {
    const ids = [...this.elements.keys()].sort();
    const votes = [...this.votes.entries()].filter(([, v]) => v.length > 0).sort(([a], [b]) => (a < b ? -1 : 1));
    return {
      version: SNAPSHOT_VERSION,
      props: canonical(this.props),
      elements: ids.map((id) => canonical(this.elements.get(id)!)),
      ...(votes.length ? { votes: Object.fromEntries(votes.map(([u, v]) => [u, [...v]])) } : {}),
    };
  }

  get(id: string): BoardElement | undefined {
    return this.elements.get(id);
  }

  get size(): number {
    return this.elements.size;
  }

  /** Records a change to `id` (ops call this). */
  touch(id: string, structural: boolean): void {
    this.dirty.add(id);
    if (structural) this.structureVersion++;
  }

  /** Ids changed since the last call, and forgets them. */
  takeDirty(): Set<string> {
    const out = this.dirty;
    this.dirty = new Set();
    return out;
  }

  /** The parent an element is drawn in: its parent if that still exists, else the top level. */
  effectiveParent(el: BoardElement): string | null {
    const p = el.parent ?? null;
    if (p === null) return null;
    const parent = this.elements.get(p);
    return parent && (parent.type === 'frame' || parent.type === 'group') ? p : null;
  }

  /** Children by parent id (null: the top level), each list in stacking order. */
  childrenMap(): Map<string | null, BoardElement[]> {
    if (this.childrenCache?.version === this.structureVersion) return this.childrenCache.map;
    const map = new Map<string | null, BoardElement[]>();
    for (const el of this.elements.values()) {
      const p = this.effectiveParent(el);
      let list = map.get(p);
      if (!list) map.set(p, (list = []));
      list.push(el);
    }
    for (const list of map.values()) list.sort(compareOrder);
    // Elements are replaced on every change, so keep the lists pointing at ids, not stale objects.
    this.childrenCache = { version: this.structureVersion, map };
    return map;
  }

  /** Ids of the children of `parent` (null: top level), in stacking order. */
  childIds(parent: string | null): string[] {
    return (this.childrenMap().get(parent) ?? []).map((e) => e.id);
  }

  /** Every element in paint order: each frame or group followed by its contents. */
  paintOrder(): BoardElement[] {
    if (this.paintCache?.version === this.version) return this.paintCache.list;
    const map = this.childrenMap();
    const out: BoardElement[] = [];
    const seen = new Set<string>();
    const visit = (parent: string | null) => {
      for (const child of map.get(parent) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        const current = this.elements.get(child.id);
        if (!current) continue;
        out.push(current);
        if (current.type === 'frame' || current.type === 'group') visit(current.id);
      }
    };
    visit(null);
    this.paintCache = { version: this.version, list: out };
    return out;
  }

  /** `id` and everything inside it (frames and groups), deepest last. */
  descendants(id: string): string[] {
    const map = this.childrenMap();
    const out: string[] = [];
    const walk = (p: string) => {
      for (const c of map.get(p) ?? []) {
        if (out.includes(c.id)) continue;
        out.push(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  /** Whether `ancestor` contains `id` (directly or deeper). */
  isInside(id: string, ancestor: string): boolean {
    let current = this.elements.get(id);
    for (let guard = 0; current && guard < 1000; guard++) {
      const p = current.parent ?? null;
      if (p === null) return false;
      if (p === ancestor) return true;
      current = this.elements.get(p);
    }
    return false;
  }

  /** The order key of the topmost child of `parent`, for putting something on top. */
  topOrder(parent: string | null): string | null {
    const list = this.childrenMap().get(parent);
    return list?.length ? list[list.length - 1]!.order : null;
  }

  bottomOrder(parent: string | null): string | null {
    const list = this.childrenMap().get(parent);
    return list?.length ? list[0]!.order : null;
  }
}

/**
 * A deep copy with object keys in sorted order. Replicas reach the same
 * board through different paths (a client rebases, the room does not), which
 * can leave keys in a different order; snapshots must not depend on that.
 */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out as T;
  }
  return value;
}

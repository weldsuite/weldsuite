/**
 * Row heights or column widths for one sheet axis.
 *
 * A million rows mostly share the default size, so only overrides are stored.
 * Offsets come from a sorted list of overridden indices with prefix sums of
 * their deltas, giving O(log n) index → pixel and pixel → index lookups for
 * the renderer. Hidden entries have size 0.
 */

export interface AxisSnapshot {
  defaultSize: number;
  sizes?: [number, number][];
  hidden?: number[];
  styles?: [number, string][];
}

export class AxisDims {
  private readonly sizes = new Map<number, number>();
  private readonly hidden = new Set<number>();
  /** Default style per row/column (formatting a whole column). */
  readonly styles = new Map<number, string>();

  private index: number[] | null = null;
  private prefix: number[] = [];

  constructor(public defaultSize: number) {}

  sizeOf(i: number): number {
    if (this.hidden.has(i)) return 0;
    return this.sizes.get(i) ?? this.defaultSize;
  }

  /** The size ignoring hidden state (what the row comes back at when unhidden). */
  storedSize(i: number): number | undefined {
    return this.sizes.get(i);
  }

  isHidden(i: number): boolean {
    return this.hidden.has(i);
  }

  setSize(i: number, size: number | undefined): void {
    if (size === undefined || size === this.defaultSize) this.sizes.delete(i);
    else this.sizes.set(i, size);
    this.index = null;
  }

  setHidden(i: number, hidden: boolean): void {
    if (hidden) this.hidden.add(i);
    else this.hidden.delete(i);
    this.index = null;
  }

  /** Pixel offset of the start of `i`. */
  offsetOf(i: number): number {
    this.build();
    const idx = this.index!;
    // Number of overrides strictly before i.
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    return i * this.defaultSize + this.prefix[lo]!;
  }

  /** The index whose span contains pixel `px` (clamped at 0). */
  indexAt(px: number): number {
    if (px <= 0) return this.firstVisibleFrom(0);
    this.build();
    const idx = this.index!;
    // Largest k with offsetOf(idx[k]) <= px.
    let lo = 0;
    let hi = idx.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid]! * this.defaultSize + this.prefix[mid]! <= px) {
        k = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (k < 0) return Math.floor(px / this.defaultSize);
    const at = idx[k]!;
    const start = at * this.defaultSize + this.prefix[k]!;
    const size = this.sizeOf(at);
    if (px < start + size) return at;
    return at + 1 + Math.floor((px - start - size) / this.defaultSize);
  }

  private firstVisibleFrom(i: number): number {
    let j = i;
    while (this.hidden.has(j)) j++;
    return j;
  }

  /** Shift overrides for `count` entries inserted before `at`. */
  insert(at: number, count: number): void {
    shiftMap(this.sizes, (i) => (i >= at ? i + count : i));
    shiftMap(this.styles, (i) => (i >= at ? i + count : i));
    shiftSet(this.hidden, (i) => (i >= at ? i + count : i));
    this.index = null;
  }

  delete(at: number, count: number): void {
    const end = at + count;
    const map = (i: number) => {
      if (i < at) return i;
      return i >= end ? i - count : -1;
    };
    shiftMap(this.sizes, map);
    shiftMap(this.styles, map);
    shiftSet(this.hidden, map);
    this.index = null;
  }

  /** Apply an arbitrary index mapping (used for moves). -1 drops the entry. */
  remap(map: (i: number) => number): void {
    shiftMap(this.sizes, map);
    shiftMap(this.styles, map);
    shiftSet(this.hidden, map);
    this.index = null;
  }

  private build(): void {
    if (this.index) return;
    const keys = new Set<number>([...this.sizes.keys(), ...this.hidden]);
    const idx = [...keys].sort((a, b) => a - b);
    const prefix = new Array<number>(idx.length + 1);
    prefix[0] = 0;
    for (let k = 0; k < idx.length; k++) {
      prefix[k + 1] = prefix[k]! + (this.sizeOf(idx[k]!) - this.defaultSize);
    }
    this.index = idx;
    this.prefix = prefix;
  }

  toJSON(): AxisSnapshot {
    const snap: AxisSnapshot = { defaultSize: this.defaultSize };
    // Sorted, so equal states give byte-identical snapshots (replica checksums).
    if (this.sizes.size) snap.sizes = [...this.sizes].sort((a, b) => a[0] - b[0]);
    if (this.hidden.size) snap.hidden = [...this.hidden].sort((a, b) => a - b);
    if (this.styles.size) snap.styles = [...this.styles].sort((a, b) => a[0] - b[0]);
    return snap;
  }

  static fromJSON(snap: AxisSnapshot): AxisDims {
    const axis = new AxisDims(snap.defaultSize);
    for (const [i, s] of snap.sizes ?? []) axis.sizes.set(i, s);
    for (const i of snap.hidden ?? []) axis.hidden.add(i);
    for (const [i, s] of snap.styles ?? []) axis.styles.set(i, s);
    return axis;
  }
}

function shiftMap<V>(m: Map<number, V>, map: (i: number) => number): void {
  if (m.size === 0) return;
  const entries = [...m];
  m.clear();
  for (const [i, v] of entries) {
    const j = map(i);
    if (j >= 0) m.set(j, v);
  }
}

function shiftSet(s: Set<number>, map: (i: number) => number): void {
  if (s.size === 0) return;
  const items = [...s];
  s.clear();
  for (const i of items) {
    const j = map(i);
    if (j >= 0) s.add(j);
  }
}

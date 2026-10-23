/**
 * Operational transform for concurrent ops.
 *
 * `transform(op, against, opWins)` returns `op` rewritten to apply after
 * `against`, where both were made against the same state. Collaboration is
 * server-sequenced, so only this one function is needed (no TP2):
 *
 * - server, for an incoming client op:     transform(clientOp, committed, true)
 * - client, for an incoming server op: undo its own pending ops (their
 *   inverses), apply the server op, then re-apply its pending ops as
 *   transform(ownPending, serverOp, true), exactly what the server will
 *   compute when they arrive. Both sides then run the same ops in the same
 *   order, so they agree even where the two transform directions do not
 *   commute.
 *
 * `opWins` says which op the server applied later. On conflicting writes to
 * the same thing (one cell, one sheet's freeze, two sheets given the same
 * name) the later one wins, and the losing side's transform either drops the
 * conflicting part or re-asserts the winner's value, so that the opposite
 * direction (used for the undo stack) converges as well wherever it can.
 *
 * Where it cannot without seeing state (concurrent row/column inserts,
 * deletes and moves at the edge of a merge, sheet reordering, a range format racing a whole-row/column style
 * change it inherits from), clients still agree because they rebase as
 * above; the collaboration layer also compares state checksums and resyncs
 * from a snapshot if replicas ever disagree.
 */

import { MAX_COLS, MAX_ROWS, type Range } from '../address';
import {
  adjustForDelete,
  adjustForInsert,
  adjustForMove,
  indexAfterDelete,
  moveIndexMapper,
  removeSheetFromFormula,
  renameSheetInFormula,
} from '../formula/references';
import type { DefinedName } from '../model/workbook';
import { nameKey, NOOP, normalize, type CellPatch, type NameKey, type Op } from './types';

export function transform(op: Op, against: Op, opWins: boolean): Op {
  if (against.type === 'batch') {
    let out = op;
    for (const b of against.ops) out = transform(out, b, opWins);
    return out;
  }
  if (op.type === 'batch') {
    const out: Op[] = [];
    let b: Op = against;
    for (const a of op.ops) {
      out.push(transform(a, b, opWins));
      b = transform(b, a, !opWins);
    }
    return normalize({ type: 'batch', ops: out });
  }
  return normalize(transformSimple(op, against, opWins));
}

/** Transforms each op of a list (a client's pending queue) past `against`, in order. */
export function transformList(ops: Op[], against: Op, opsWin: boolean): { ops: Op[]; against: Op } {
  const out: Op[] = [];
  let b = against;
  for (const a of ops) {
    out.push(transform(a, b, opsWin));
    b = transform(b, a, !opsWin);
  }
  return { ops: out, against: b };
}

type Simple = Exclude<Op, { type: 'batch' }>;
type OpOf<T extends Op['type']> = Extract<Op, { type: T }>;

function transformSimple(a: Simple, b: Simple, aWins: boolean): Op {
  switch (b.type) {
    case 'insertDims':
    case 'deleteDims':
    case 'moveDims':
      return overStructural(a, b, aWins);
    case 'renameSheet':
      return overRename(a, b, aWins);
    case 'deleteSheet':
      return overDeleteSheet(a, b);
    case 'addSheet':
      return overAddSheet(a, b, aWins);
    case 'moveSheet':
      return a.type === 'moveSheet' && a.sheetId === b.sheetId && !aWins ? NOOP : a;
    case 'setCells':
      return overSetCells(a, b, aWins);
    case 'formatRanges':
    case 'setStyles':
      return overStyle(a, b, aWins);
    case 'resizeDims':
      return overResize(a, b, aWins);
    case 'hideDims':
      return overHide(a, b, aWins);
    case 'setFreeze':
      return a.type === 'setFreeze' && a.sheetId === b.sheetId && !aWins ? NOOP : a;
    case 'setSheetProps':
      return overSheetProps(a, b, aWins);
    case 'setGridSize':
      return overGridSize(a, b, aWins);
    case 'merge':
      return overMerge(a, b, aWins);
    case 'unmerge':
      return overUnmerge(a, b, aWins);
    case 'setNames':
      // b replaced the whole list after a: a name list or patch that lost changes nothing.
      return (a.type === 'setNames' || a.type === 'patchNames') && !aWins ? NOOP : a;
    case 'patchNames':
      return overPatchNames(a, b, aWins);
  }
}

// ---------------------------------------------------------------------------
// Past row/column insert, delete and move
// ---------------------------------------------------------------------------

type Structural = OpOf<'insertDims' | 'deleteDims' | 'moveDims'>;
/** Ops that belong to one sheet. */
type SheetOp = Exclude<Simple, { type: 'setCells' | 'setNames' | 'patchNames' }>;
/** Ops on one axis of one sheet. */
type AxisOp = OpOf<'resizeDims' | 'hideDims' | 'insertDims' | 'deleteDims' | 'moveDims'>;

function overStructural(a: Simple, b: Structural, aWins: boolean): Op {
  switch (a.type) {
    case 'setCells':
      return cellsAfter(a, b);
    case 'setNames':
    case 'patchNames': {
      const formula = formulaAdjuster(b);
      return mapNames(a, (n) => ({ ...n, formula: formula(n.formula, n.sheetId ?? '') }));
    }
    default:
      // Everything else changes only when it is about b's own sheet.
      return a.sheetId === b.sheetId ? sameSheetAfter(a, b, aWins) : a;
  }
}

/** Rewrites a formula that lives on sheet `hostSheetId` for b's change. */
function formulaAdjuster(b: Structural): (f: string, hostSheetId: string) => string {
  return (f, hostSheetId) => {
    // On another sheet, a host name no sheet can have: only explicit references to b's sheet move.
    const host = hostSheetId === b.sheetId ? b.sheetName : `\u0000${hostSheetId}`;
    switch (b.type) {
      case 'insertDims':
        return adjustForInsert(f, host, {
          sheet: b.sheetName,
          axis: b.axis,
          at: b.at,
          count: b.count,
        });
      case 'deleteDims':
        return adjustForDelete(f, host, {
          sheet: b.sheetName,
          axis: b.axis,
          at: b.at,
          count: b.count,
        });
      case 'moveDims':
        return adjustForMove(f, host, {
          sheet: b.sheetName,
          axis: b.axis,
          from: b.from,
          count: b.count,
          to: b.to,
        });
    }
  };
}

/** Cells on b's sheet move (or go, when deleted); formulas on every sheet are adjusted. */
function cellsAfter(a: OpOf<'setCells'>, b: Structural): Op {
  const formula = formulaAdjuster(b);
  const index = a.sheetId === b.sheetId ? indexMapper(b) : (i: number) => i;
  const rowAxis = b.axis === 'row';
  const cells: CellPatch[] = [];
  for (const [row, col, content] of a.cells) {
    const i = index(rowAxis ? row : col);
    if (i < 0) continue;
    const next = content?.f !== undefined ? { ...content, f: formula(content.f, a.sheetId) } : content;
    cells.push(rowAxis ? [i, col, next] : [row, i, next]);
  }
  return { ...a, cells };
}

/** An op about b's own sheet, past b. */
function sameSheetAfter(a: SheetOp, b: Structural, aWins: boolean): Op {
  switch (a.type) {
    case 'formatRanges':
      // New rows/columns start unstyled on the engine: formatting goes around them.
      return { ...a, ranges: a.ranges.flatMap((r) => mapRange(r, b, true)) };
    case 'unmerge':
      return { ...a, ranges: a.ranges.flatMap((r) => mapRange(r, b)) };
    case 'merge':
      // A merge split by a move is dropped, as the engine drops existing ones.
      return {
        ...a,
        ranges: a.ranges.flatMap((r) => {
          const out = mapRange(r, b);
          return out.length === 1 ? out : [];
        }),
      };
    case 'setStyles':
      return stylesAfter(a, b);
    case 'resizeDims':
    case 'hideDims':
    case 'insertDims':
    case 'deleteDims':
    case 'moveDims':
      return a.axis === b.axis ? sameAxisAfter(a, b, aWins) : a;
    case 'setFreeze': {
      const key = b.axis === 'row' ? 'rows' : 'cols';
      return { ...a, [key]: freezeAfter(a[key], b) };
    }
    case 'setGridSize':
      return gridSizeAfter(a, b);
    case 'addSheet':
    case 'deleteSheet':
    case 'renameSheet':
    case 'moveSheet':
    case 'setSheetProps':
      return a;
  }
}

/** An op on the same sheet and axis as b, past b. */
function sameAxisAfter(a: AxisOp, b: Structural, aWins: boolean): Op {
  switch (a.type) {
    case 'resizeDims': {
      const index = indexMapper(b);
      return {
        ...a,
        entries: a.entries.flatMap(([i, v]): [number, number | null][] => (index(i) < 0 ? [] : [[index(i), v]])),
      };
    }
    case 'hideDims':
      return { ...a, indices: a.indices.map(indexMapper(b)).filter((i) => i >= 0) };
    case 'insertDims':
      // Rows inserted strictly inside a band someone deleted go with it (deletesAfter mirrors this).
      if (b.type === 'deleteDims' && a.at > b.at && a.at < b.at + b.count) return NOOP;
      return { ...a, at: boundary(a.at, b, aWins) };
    case 'deleteDims':
      return deletesAfter(a, b);
    case 'moveDims':
      return moveAfter(a, b, aWins);
  }
}

function stylesAfter(a: OpOf<'setStyles'>, b: Structural): Op {
  const index = indexMapper(b);
  const rowAxis = b.axis === 'row';
  const cells = a.cells.flatMap(([row, col, key]): [number, number, string | null][] => {
    const i = index(rowAxis ? row : col);
    if (i < 0) return [];
    return [rowAxis ? [i, col, key] : [row, i, key]];
  });
  const out = { ...a, cells };
  const entries = rowAxis ? a.rows : a.cols;
  if (entries) {
    const mapped = entries.flatMap(([i, v]): [number, string | null][] => (index(i) < 0 ? [] : [[index(i), v]]));
    if (rowAxis) out.rows = mapped;
    else out.cols = mapped;
  }
  return out;
}

/** An explicit grid size on b's axis grows or shrinks with an insert or delete. */
function gridSizeAfter(a: OpOf<'setGridSize'>, b: Structural): Op {
  if (b.type === 'moveDims') return a;
  const key = b.axis === 'row' ? 'rowCount' : 'colCount';
  const n = a[key];
  if (n === undefined) return a;
  const delta = b.type === 'insertDims' ? b.count : -b.count;
  const max = b.axis === 'row' ? MAX_ROWS : MAX_COLS;
  return {
    ...a,
    [key]: Math.max(1, Math.min(max, n + delta)),
  };
}

/** Where an index ends up after `b`; -1 if `b` deleted it. */
function indexMapper(b: Structural): (i: number) => number {
  switch (b.type) {
    case 'insertDims':
      return (i) => (i >= b.at ? i + b.count : i);
    case 'deleteDims':
      return (i) => indexAfterDelete(i, b.at, b.count, -1);
    case 'moveDims':
      return moveIndexMapper(b.from, b.count, b.to);
  }
}

/** An insertion point ("before index at") after `b`. */
function boundary(at: number, b: Structural, aWins: boolean): number {
  switch (b.type) {
    case 'insertDims':
      return at > b.at || (at === b.at && !aWins) ? at + b.count : at;
    case 'deleteDims':
      // A gap inside the deleted band closes up to where the band started.
      return at <= b.at ? at : indexAfterDelete(at, b.at, b.count, b.at);
    case 'moveDims':
      return boundaryAfterMove(at, b, aWins);
  }
}

/** `at` is the gap in front of row `at`. */
function boundaryAfterMove(at: number, b: OpOf<'moveDims'>, aWins: boolean): number {
  const map = moveIndexMapper(b.from, b.count, b.to);
  const noop = b.to >= b.from && b.to <= b.from + b.count;
  // b's block landed in this same gap: the op the server applied later goes first, as with two inserts.
  if (!noop && at === b.to) return aWins ? map(b.from) : map(at);
  // The gap in front of b's block stays where the block left from.
  if (!noop && at === b.from) return at === 0 ? 0 : map(at - 1) + 1;
  return map(at);
}

/** Where a range's cells end up after `b`: zero, one or (after a move splits it) several ranges. */
/**
 * Where a range's cells end up after `b`. An insert inside the range widens it,
 * unless `splitAroundInsert`, which leaves the new rows/columns out.
 */
function rangeAfterInsert(r: Range, b: OpOf<'insertDims'>, split: boolean): Range[] {
  const [lo, hi, max] = b.axis === 'row' ? (['r1', 'r2', MAX_ROWS] as const) : (['c1', 'c2', MAX_COLS] as const);
  const shift = (i: number) => (i >= b.at ? i + b.count : i);
  if (split && r[lo] < b.at && r[hi] >= b.at) {
    const after = Math.min(r[hi] + b.count, max - 1);
    const head = { ...r, [hi]: b.at - 1 };
    return b.at + b.count <= after ? [head, { ...r, [lo]: b.at + b.count, [hi]: after }] : [head];
  }
  const nlo = shift(r[lo]);
  if (nlo >= max) return [];
  return [{ ...r, [lo]: nlo, [hi]: Math.min(shift(r[hi]), max - 1) }];
}

function mapRange(r: Range, b: Structural, splitAroundInsert = false): Range[] {
  const [lo, hi, max] = b.axis === 'row' ? (['r1', 'r2', MAX_ROWS] as const) : (['c1', 'c2', MAX_COLS] as const);
  const full = r[lo] === 0 && r[hi] === max - 1;
  if (full) return [r];
  switch (b.type) {
    case 'insertDims':
      return rangeAfterInsert(r, b, splitAroundInsert);
    case 'deleteDims': {
      const nlo = indexAfterDelete(r[lo], b.at, b.count, b.at);
      const nhi = indexAfterDelete(r[hi], b.at, b.count, b.at - 1);
      return nlo > nhi ? [] : [{ ...r, [lo]: nlo, [hi]: nhi }];
    }
    case 'moveDims': {
      const map = moveIndexMapper(b.from, b.count, b.to);
      const targets: number[] = [];
      for (let i = r[lo]; i <= r[hi]; i++) targets.push(map(i));
      return runs(targets).map(([at, n]) => ({
        ...r,
        [lo]: at,
        [hi]: at + n - 1,
      }));
    }
  }
}

function deletesAfter(a: OpOf<'deleteDims'>, b: Structural): Op {
  const end = a.at + a.count;
  if (b.type === 'insertDims') {
    if (b.at <= a.at) return { ...a, at: a.at + b.count };
    if (b.at >= end) return a;
    // b inserted inside the band we delete: the inserted rows are deleted too.
    return { ...a, count: a.count + b.count };
  }
  // Delete or move: map every index we delete, then delete the survivors as
  // contiguous runs from the bottom up so earlier runs keep their numbering.
  const map = indexMapper(b);
  const targets: number[] = [];
  for (let i = a.at; i < end; i++) {
    const j = map(i);
    if (j >= 0) targets.push(j);
  }
  if (targets.length === 0) return NOOP;
  return {
    type: 'batch',
    ops: runs(targets)
      .reverse()
      .map(([at, count]) => ({ ...a, at, count })),
  };
}

/** Sorted contiguous runs [start, length] of a set of indices. */
function runs(indices: number[]): [number, number][] {
  const sorted = [...indices].sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === t) last[1]++;
    else out.push([t, 1]);
  }
  return out;
}

function moveAfter(a: OpOf<'moveDims'>, b: Structural, aWins: boolean): Op {
  const end = a.from + a.count;
  switch (b.type) {
    case 'insertDims': {
      const inside = b.at > a.from && b.at < end;
      return {
        ...a,
        from: a.from >= b.at ? a.from + b.count : a.from,
        count: inside ? a.count + b.count : a.count,
        to: boundary(a.to, b, aWins),
      };
    }
    case 'deleteDims': {
      const map = indexMapper(b);
      const kept: number[] = [];
      for (let i = a.from; i < end; i++) if (map(i) >= 0) kept.push(map(i));
      if (kept.length === 0) return NOOP;
      return {
        ...a,
        from: kept[0]!,
        count: kept.length,
        to: boundary(a.to, b, aWins),
      };
    }
    case 'moveDims':
      return moveAfterMove(a, b, aWins);
  }
}

/** Rows both moved stay where the winner put them; the loser moves only the rest. */
function moveAfterMove(a: OpOf<'moveDims'>, b: OpOf<'moveDims'>, aWins: boolean): Op {
  const groups = runsAfterMove(a, b, aWins);
  if (groups.length === 0) return NOOP;
  // b may have split our block: move run after run into the target gap, in order.
  let gap = boundary(a.to, b, aWins);
  const ops: Op[] = [];
  for (let k = 0; k < groups.length; k++) {
    const [s, n] = groups[k]!;
    ops.push({ ...a, from: s, count: n, to: gap });
    const m = moveIndexMapper(s, n, gap);
    for (let j = k + 1; j < groups.length; j++) groups[j]![0] = m(groups[j]![0]);
    gap = movedBlockStart(s, n, gap) + n;
  }
  return { type: 'batch', ops };
}

/** a's rows in their original order, at their positions after b, grouped into runs. */
function runsAfterMove(a: OpOf<'moveDims'>, b: OpOf<'moveDims'>, aWins: boolean): [number, number][] {
  const map = moveIndexMapper(b.from, b.count, b.to);
  const end = a.from + a.count;
  const bEnd = b.from + b.count;
  const groups: [number, number][] = [];
  for (let i = a.from; i < end; i++) {
    if (!aWins && i >= b.from && i < bEnd) continue;
    const p = map(i);
    const last = groups[groups.length - 1];
    if (last && last[0] + last[1] === p) last[1]++;
    else groups.push([p, 1]);
  }
  return groups;
}

/** Where block [from, from+count) starts once moved to gap `to`; a gap inside it or at its edges leaves it in place. */
function movedBlockStart(from: number, count: number, to: number): number {
  if (to < from) return to;
  return to > from + count ? to - count : from;
}

function freezeAfter(n: number, b: Structural): number {
  if (b.type === 'insertDims') return b.at < n ? n + b.count : n;
  if (b.type === 'deleteDims') return b.at < n ? Math.max(b.at, n - Math.min(b.count, n - b.at)) : n;
  return n;
}

// ---------------------------------------------------------------------------
// Past sheet-level changes
// ---------------------------------------------------------------------------

function mapFormulas(a: Simple, fn: (f: string) => string): Simple {
  switch (a.type) {
    case 'setCells':
      return {
        ...a,
        cells: a.cells.map(
          ([r, c, content]): CellPatch => [r, c, content?.f !== undefined ? { ...content, f: fn(content.f) } : content],
        ),
      };
    case 'setNames':
    case 'patchNames':
      return mapNames(a, (n) => ({ ...n, formula: fn(n.formula) }));
    default:
      return a;
  }
}

/** The names a setNames or patchNames writes, mapped (and filtered with `keep`). */
function mapNames(
  a: NamesOp,
  fn: (n: DefinedName) => DefinedName,
  keep: (n: NameKey) => boolean = () => true,
): NamesOp {
  if (a.type === 'setNames') return { ...a, names: a.names.filter(keep).map(fn) };
  const out: OpOf<'patchNames'> = { type: 'patchNames' };
  if (a.set) out.set = a.set.filter(keep).map(fn);
  if (a.remove) out.remove = a.remove.filter(keep);
  return out;
}

type NamesOp = OpOf<'setNames' | 'patchNames'>;

/**
 * Two name patches: the later one decides each name both touch, so a losing
 * patch drops those names. A losing full list is followed by the patch again.
 */
function overPatchNames(a: Simple, b: OpOf<'patchNames'>, aWins: boolean): Op {
  if (aWins) return a;
  if (a.type === 'setNames') return { type: 'batch', ops: [a, b] };
  if (a.type !== 'patchNames') return a;
  const taken = new Set([...(b.set ?? []), ...(b.remove ?? [])].map(nameKey));
  return mapNames(a, (n) => n, (n) => !taken.has(nameKey(n)));
}

function overRename(a: Simple, b: OpOf<'renameSheet'>, aWins: boolean): Op {
  let out: Simple = mapFormulas(a, (f) => renameSheetInFormula(f, b.oldName, b.name));
  if ('sheetName' in out && out.sheetId === b.sheetId) out = { ...out, sheetName: b.name };
  if (out.type === 'renameSheet' && out.sheetId === b.sheetId) {
    return aWins ? { ...out, oldName: b.name } : NOOP;
  }
  return resolveNameClash(out, b.sheetId, b.name, aWins);
}

function overDeleteSheet(a: Simple, b: OpOf<'deleteSheet'>): Op {
  if ('sheetId' in a && a.sheetId === b.sheetId) return NOOP;
  // Names scoped to the deleted sheet go with it, as the engine drops them.
  const kept =
    a.type === 'setNames' || a.type === 'patchNames'
      ? mapNames(a, (n) => n, (n) => n.sheetId !== b.sheetId)
      : a;
  return mapFormulas(kept, (f) => removeSheetFromFormula(f, b.sheetName));
}

function overAddSheet(a: Simple, b: OpOf<'addSheet'>, aWins: boolean): Op {
  let out: Simple = a;
  if (out.type === 'addSheet' || out.type === 'moveSheet') {
    // Sheets after b's slot shift right. At the slot itself a move always does; an add only when it lost.
    const shiftsAtSlot = out.type === 'moveSheet' || !aWins;
    if (out.index > b.index || (out.index === b.index && shiftsAtSlot)) out = { ...out, index: out.index + 1 };
  }
  return resolveNameClash(out, b.sheetId, b.name, aWins);
}

/**
 * Two sheets ended up with the same name. The sheet named by the op the server
 * applied later gets " (2)": as an op tweak when `a` won, or by renaming the
 * other sheet first when `a` lost (its own side already applied `a`).
 */
function resolveNameClash(a: Simple, otherSheetId: string, otherName: string, aWins: boolean): Op {
  if (a.type !== 'addSheet' && a.type !== 'renameSheet') return a;
  const name = a.name;
  if (a.sheetId === otherSheetId || name.toLowerCase() !== otherName.toLowerCase()) return a;
  const deduped = `${name} (2)`;
  if (aWins) return { ...a, name: deduped };
  return {
    type: 'batch',
    ops: [
      {
        type: 'renameSheet',
        sheetId: otherSheetId,
        oldName: otherName,
        name: deduped,
      },
      a,
    ],
  };
}

// ---------------------------------------------------------------------------
// Past writes to the same cells, rows, columns or sheet settings: the op the
// server applied later wins, so a losing `a` drops what `b` also wrote.
// ---------------------------------------------------------------------------

function overSetCells(a: Simple, b: OpOf<'setCells'>, aWins: boolean): Op {
  if (aWins || a.type !== 'setCells' || a.sheetId !== b.sheetId) return a;
  const taken = new Set(b.cells.map(([r, c]) => r * MAX_COLS + c));
  return {
    ...a,
    cells: a.cells.filter(([r, c]) => !taken.has(r * MAX_COLS + c)),
  };
}

function overResize(a: Simple, b: OpOf<'resizeDims'>, aWins: boolean): Op {
  if (aWins || a.type !== 'resizeDims' || a.sheetId !== b.sheetId || a.axis !== b.axis) return a;
  const taken = new Set(b.entries.map(([i]) => i));
  return { ...a, entries: a.entries.filter(([i]) => !taken.has(i)) };
}

/** Only opposite changes conflict: hiding what the other side hid too ends the same. */
function overHide(a: Simple, b: OpOf<'hideDims'>, aWins: boolean): Op {
  if (aWins || a.type !== 'hideDims' || a.sheetId !== b.sheetId || a.axis !== b.axis) return a;
  if (a.hidden === b.hidden) return a;
  const taken = new Set(b.indices);
  return { ...a, indices: a.indices.filter((i) => !taken.has(i)) };
}

function overSheetProps(a: Simple, b: OpOf<'setSheetProps'>, aWins: boolean): Op {
  if (aWins || a.type !== 'setSheetProps' || a.sheetId !== b.sheetId) return a;
  const props = { ...a.props };
  for (const k of Object.keys(b.props)) delete (props as Record<string, unknown>)[k];
  return { ...a, props };
}

function overGridSize(a: Simple, b: OpOf<'setGridSize'>, aWins: boolean): Op {
  if (aWins || a.type !== 'setGridSize' || a.sheetId !== b.sheetId) return a;
  const out = { ...a };
  if (b.rowCount !== undefined) delete out.rowCount;
  if (b.colCount !== undefined) delete out.colCount;
  return out;
}

/** A losing merge that overlaps one of b's is dropped. */
/**
 * Merges and unmerges on one sheet. A merge replaces the merges it overlaps,
 * an unmerge removes every merge it overlaps, and both are idempotent, so a
 * losing op is followed by the winner again: both replicas end with "loser,
 * then winner", the server order.
 */
function overMerge(a: Simple, b: OpOf<'merge'>, aWins: boolean): Op {
  return reassert(a, b, aWins);
}

function overUnmerge(a: Simple, b: OpOf<'unmerge'>, aWins: boolean): Op {
  return reassert(a, b, aWins);
}

function reassert(a: Simple, b: OpOf<'merge' | 'unmerge'>, aWins: boolean): Op {
  if (aWins || (a.type !== 'merge' && a.type !== 'unmerge') || a.sheetId !== b.sheetId) return a;
  return { type: 'batch', ops: [a, b] };
}

// ---------------------------------------------------------------------------
// Past style changes
// ---------------------------------------------------------------------------

/**
 * Two style ops on one sheet (formatRanges, setStyles; cells, rows and
 * columns). The op the server applied later decides every property both
 * touch, and its result depends on the styles it was applied over (a patch
 * lands on whatever row/column style a cell inherits). So a losing op is
 * followed by the winner again: applying a style op a second time changes
 * nothing, and both replicas end with "loser, then winner" without the
 * transform having to know any cell's current style.
 */
function overStyle(a: Simple, b: OpOf<'formatRanges' | 'setStyles'>, aWins: boolean): Op {
  if (aWins || (a.type !== 'formatRanges' && a.type !== 'setStyles') || a.sheetId !== b.sheetId) return a;
  return { type: 'batch', ops: [a, b] };
}

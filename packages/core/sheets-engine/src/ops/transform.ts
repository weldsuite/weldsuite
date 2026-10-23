/**
 * Operational transform for concurrent ops.
 *
 * `transform(op, against, opWins)` returns `op` rewritten to apply after
 * `against`, where both were made against the same state. Collaboration is
 * server-sequenced, so only this one function is needed (no TP2):
 *
 * - server, for an incoming client op:     transform(clientOp, committed, true)
 * - client, for an incoming server op:     transform(serverOp, ownPending, false)
 * - client, for its own pending op:        transform(ownPending, serverOp, true)
 *
 * `opWins` says which op the server applied later. On conflicting writes to
 * the same thing (one cell, one sheet's freeze, two sheets given the same
 * name) the later one wins, and the losing side's transform either drops the
 * conflicting part or re-asserts the winner's value so both sides converge.
 *
 * A few rare combinations (two concurrent row moves overlapping, sheet
 * reordering) are approximate; the collaboration layer compares state
 * checksums and resyncs from a snapshot if replicas ever disagree.
 */

import { MAX_COLS, MAX_ROWS, rangeIntersection, rangesIntersect, type Range } from '../address';
import {
  adjustForDelete,
  adjustForInsert,
  adjustForMove,
  moveIndexMapper,
  removeSheetFromFormula,
  renameSheetInFormula,
} from '../formula/references';
import { applyStylePatch, styleKey, type CellStyle, type StylePatch } from '../model/styles';
import { NOOP, normalize, type CellPatch, type Op } from './types';

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
      if (a.type === 'setCells' && a.sheetId === b.sheetId && !aWins) {
        const taken = new Set(b.cells.map(([r, c]) => r * MAX_COLS + c));
        return {
          ...a,
          cells: a.cells.filter(([r, c]) => !taken.has(r * MAX_COLS + c)),
        };
      }
      return a;
    case 'formatRanges':
      return overFormat(a, b, aWins);
    case 'setStyles':
      return overSetStyles(a, b, aWins);
    case 'resizeDims':
      if (a.type === 'resizeDims' && a.sheetId === b.sheetId && a.axis === b.axis && !aWins) {
        const taken = new Set(b.entries.map(([i]) => i));
        return { ...a, entries: a.entries.filter(([i]) => !taken.has(i)) };
      }
      return a;
    case 'hideDims':
      if (a.type === 'hideDims' && a.sheetId === b.sheetId && a.axis === b.axis && !aWins && a.hidden !== b.hidden) {
        const taken = new Set(b.indices);
        return { ...a, indices: a.indices.filter((i) => !taken.has(i)) };
      }
      return a;
    case 'setFreeze':
      return a.type === 'setFreeze' && a.sheetId === b.sheetId && !aWins ? NOOP : a;
    case 'setSheetProps':
      if (a.type === 'setSheetProps' && a.sheetId === b.sheetId && !aWins) {
        const props = { ...a.props };
        for (const k of Object.keys(b.props)) delete (props as Record<string, unknown>)[k];
        return { ...a, props };
      }
      return a;
    case 'setGridSize':
      if (a.type === 'setGridSize' && a.sheetId === b.sheetId && !aWins) {
        const out = { ...a };
        if (b.rowCount !== undefined) delete out.rowCount;
        if (b.colCount !== undefined) delete out.colCount;
        return out;
      }
      return a;
    case 'merge':
      if (a.type === 'merge' && a.sheetId === b.sheetId && !aWins) {
        return {
          ...a,
          ranges: a.ranges.filter((r) => !b.ranges.some((m) => rangesIntersect(m, r))),
        };
      }
      return a;
    case 'unmerge':
      return a;
    case 'setNames':
      return a.type === 'setNames' && !aWins ? NOOP : a;
  }
}

// ---------------------------------------------------------------------------
// Past row/column insert, delete and move
// ---------------------------------------------------------------------------

type Structural = Extract<Op, { type: 'insertDims' | 'deleteDims' | 'moveDims' }>;

function overStructural(a: Simple, b: Structural, aWins: boolean): Op {
  const same = 'sheetId' in a && a.sheetId === b.sheetId;
  const axis = b.axis;
  const index = indexMapper(b);
  const formula = (f: string, hostSheetId: string) => {
    const host = hostSheetId === b.sheetId ? b.sheetName : `\u0000${hostSheetId}`;
    switch (b.type) {
      case 'insertDims':
        return adjustForInsert(f, host, {
          sheet: b.sheetName,
          axis,
          at: b.at,
          count: b.count,
        });
      case 'deleteDims':
        return adjustForDelete(f, host, {
          sheet: b.sheetName,
          axis,
          at: b.at,
          count: b.count,
        });
      case 'moveDims':
        return adjustForMove(f, host, {
          sheet: b.sheetName,
          axis,
          from: b.from,
          count: b.count,
          to: b.to,
        });
    }
  };

  switch (a.type) {
    case 'setCells': {
      const cells: CellPatch[] = [];
      for (const [row, col, content] of a.cells) {
        let r = row;
        let c = col;
        if (same) {
          const i = index(axis === 'row' ? row : col);
          if (i < 0) continue;
          if (axis === 'row') r = i;
          else c = i;
        }
        cells.push([r, c, content?.f !== undefined ? { ...content, f: formula(content.f, a.sheetId) } : content]);
      }
      return { ...a, cells };
    }
    case 'formatRanges':
    case 'unmerge':
      if (!same) return a;
      return { ...a, ranges: a.ranges.flatMap((r) => mapRange(r, b)) };
    case 'merge':
      if (!same) return a;
      // A merge split by a move is dropped, as the engine drops existing ones.
      return {
        ...a,
        ranges: a.ranges.flatMap((r) => {
          const out = mapRange(r, b);
          return out.length === 1 ? out : [];
        }),
      };
    case 'setStyles': {
      if (!same) return a;
      const cells = a.cells.flatMap(([row, col, key]): [number, number, string | null][] => {
        const i = index(axis === 'row' ? row : col);
        if (i < 0) return [];
        return [axis === 'row' ? [i, col, key] : [row, i, key]];
      });
      const out = { ...a, cells };
      const entries = axis === 'row' ? a.rows : a.cols;
      if (entries) {
        const mapped = entries.flatMap(([i, v]): [number, string | null][] => (index(i) < 0 ? [] : [[index(i), v]]));
        if (axis === 'row') out.rows = mapped;
        else out.cols = mapped;
      }
      return out;
    }
    case 'resizeDims':
      if (!same || a.axis !== axis) return a;
      return {
        ...a,
        entries: a.entries.flatMap(([i, v]): [number, number | null][] => (index(i) < 0 ? [] : [[index(i), v]])),
      };
    case 'hideDims':
      if (!same || a.axis !== axis) return a;
      return { ...a, indices: a.indices.map(index).filter((i) => i >= 0) };
    case 'insertDims':
      if (!same || a.axis !== axis) return a;
      // Rows inserted strictly inside a band someone deleted go with it (deletesAfter mirrors this).
      if (b.type === 'deleteDims' && a.at > b.at && a.at < b.at + b.count) return NOOP;
      return { ...a, at: boundary(a.at, b, aWins) };
    case 'deleteDims':
      if (!same || a.axis !== axis) return a;
      return deletesAfter(a, b);
    case 'moveDims':
      if (!same || a.axis !== axis) return a;
      return moveAfter(a, b, aWins);
    case 'setFreeze': {
      if (!same) return a;
      const key = axis === 'row' ? 'rows' : 'cols';
      return { ...a, [key]: freezeAfter(a[key], b) };
    }
    case 'setGridSize': {
      if (!same || b.type === 'moveDims') return a;
      const key = axis === 'row' ? 'rowCount' : 'colCount';
      const n = a[key];
      if (n === undefined) return a;
      const delta = b.type === 'insertDims' ? b.count : -b.count;
      return {
        ...a,
        [key]: Math.max(1, Math.min(axis === 'row' ? MAX_ROWS : MAX_COLS, n + delta)),
      };
    }
    case 'setNames':
      return {
        ...a,
        names: a.names.map((n) => ({
          ...n,
          formula: formula(n.formula, n.sheetId ?? ''),
        })),
      };
    case 'addSheet':
    case 'deleteSheet':
    case 'renameSheet':
    case 'moveSheet':
    case 'setSheetProps':
      return a;
  }
}

/** Where an index ends up after `b`; -1 if `b` deleted it. */
function indexMapper(b: Structural): (i: number) => number {
  switch (b.type) {
    case 'insertDims':
      return (i) => (i >= b.at ? i + b.count : i);
    case 'deleteDims': {
      const end = b.at + b.count;
      return (i) => (i < b.at ? i : i >= end ? i - b.count : -1);
    }
    case 'moveDims':
      return moveIndexMapper(b.from, b.count, b.to);
  }
}

/** An insertion point ("before index at") after `b`. */
function boundary(at: number, b: Structural, aWins: boolean): number {
  switch (b.type) {
    case 'insertDims':
      return at > b.at || (at === b.at && !aWins) ? at + b.count : at;
    case 'deleteDims': {
      const end = b.at + b.count;
      return at <= b.at ? at : at >= end ? at - b.count : b.at;
    }
    case 'moveDims': {
      // `at` is the gap in front of row `at`.
      const map = moveIndexMapper(b.from, b.count, b.to);
      const noop = b.to >= b.from && b.to <= b.from + b.count;
      // b's block landed in this same gap: the op the server applied later goes first, as with two inserts.
      if (!noop && at === b.to) return aWins ? map(b.from) : map(at);
      // The gap in front of b's block stays where the block left from.
      if (!noop && at === b.from) return at === 0 ? 0 : map(at - 1) + 1;
      return map(at);
    }
  }
}

/** Where a range's cells end up after `b`: zero, one or (after a move splits it) several ranges. */
function mapRange(r: Range, b: Structural): Range[] {
  const axis = b.axis;
  const [lo, hi, max] = axis === 'row' ? (['r1', 'r2', MAX_ROWS] as const) : (['c1', 'c2', MAX_COLS] as const);
  const full = r[lo] === 0 && r[hi] === max - 1;
  if (full) return [r];
  let nlo: number;
  let nhi: number;
  switch (b.type) {
    case 'insertDims':
      nlo = r[lo] >= b.at ? r[lo] + b.count : r[lo];
      nhi = r[hi] >= b.at ? r[hi] + b.count : r[hi];
      if (nlo >= max) return [];
      nhi = Math.min(nhi, max - 1);
      break;
    case 'deleteDims': {
      const end = b.at + b.count;
      nlo = r[lo] < b.at ? r[lo] : r[lo] >= end ? r[lo] - b.count : b.at;
      nhi = r[hi] < b.at ? r[hi] : r[hi] >= end ? r[hi] - b.count : b.at - 1;
      if (nlo > nhi) return [];
      break;
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
  return [{ ...r, [lo]: nlo, [hi]: nhi }];
}

function deletesAfter(a: Extract<Op, { type: 'deleteDims' }>, b: Structural): Op {
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

function moveAfter(a: Extract<Op, { type: 'moveDims' }>, b: Structural, aWins: boolean): Op {
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
    case 'moveDims': {
      // Rows both moved stay where the winner put them; the loser moves only the rest.
      const map = moveIndexMapper(b.from, b.count, b.to);
      const bEnd = b.from + b.count;
      // Our rows in their original order, at their positions after b, grouped into runs.
      const groups: [number, number][] = [];
      for (let i = a.from; i < end; i++) {
        if (!aWins && i >= b.from && i < bEnd) continue;
        const p = map(i);
        const last = groups[groups.length - 1];
        if (last && last[0] + last[1] === p) last[1]++;
        else groups.push([p, 1]);
      }
      if (groups.length === 0) return NOOP;
      // b may have split our block: move run after run into the target gap, in order.
      let gap = boundary(a.to, b, aWins);
      const ops: Op[] = [];
      for (let k = 0; k < groups.length; k++) {
        const [s, n] = groups[k]!;
        ops.push({ ...a, from: s, count: n, to: gap });
        const m = moveIndexMapper(s, n, gap);
        for (let j = k + 1; j < groups.length; j++) groups[j]![0] = m(groups[j]![0]);
        gap = (gap < s ? gap : gap > s + n ? gap - n : s) + n;
      }
      return { type: 'batch', ops };
    }
  }
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
      return {
        ...a,
        names: a.names.map((n) => ({ ...n, formula: fn(n.formula) })),
      };
    default:
      return a;
  }
}

function overRename(a: Simple, b: Extract<Op, { type: 'renameSheet' }>, aWins: boolean): Op {
  let out: Simple = mapFormulas(a, (f) => renameSheetInFormula(f, b.oldName, b.name));
  if ('sheetName' in out && out.sheetId === b.sheetId) out = { ...out, sheetName: b.name };
  if (out.type === 'renameSheet' && out.sheetId === b.sheetId) {
    return aWins ? { ...out, oldName: b.name } : NOOP;
  }
  return resolveNameClash(out, b.sheetId, b.name, aWins);
}

function overDeleteSheet(a: Simple, b: Extract<Op, { type: 'deleteSheet' }>): Op {
  if ('sheetId' in a && a.sheetId === b.sheetId) return NOOP;
  return mapFormulas(a, (f) => removeSheetFromFormula(f, b.sheetName));
}

function overAddSheet(a: Simple, b: Extract<Op, { type: 'addSheet' }>, aWins: boolean): Op {
  let out: Simple = a;
  if (out.type === 'addSheet' && (out.index > b.index || (out.index === b.index && !aWins))) {
    out = { ...out, index: out.index + 1 };
  } else if (out.type === 'moveSheet' && out.index >= b.index) {
    out = { ...out, index: out.index + 1 };
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
// Past style changes
// ---------------------------------------------------------------------------

function overFormat(a: Simple, b: Extract<Op, { type: 'formatRanges' }>, aWins: boolean): Op {
  if (aWins || !('sheetId' in a) || a.sheetId !== b.sheetId) return a;
  if (a.type === 'formatRanges') {
    // Re-assert b's values for the properties both set, where both applied.
    const shared: StylePatch = {};
    for (const k of Object.keys(a.patch) as (keyof StylePatch)[]) {
      if (k in b.patch) (shared as Record<string, unknown>)[k] = b.patch[k];
    }
    if (Object.keys(shared).length === 0) return a;
    const overlap = a.ranges.flatMap((r) => b.ranges.flatMap((s) => rangeIntersection(r, s) ?? []));
    if (overlap.length === 0) return a;
    return {
      type: 'batch',
      ops: [
        a,
        {
          type: 'formatRanges',
          sheetId: a.sheetId,
          ranges: overlap,
          patch: shared,
        },
      ],
    };
  }
  if (a.type === 'setStyles') {
    // b's patch lands on top of our explicit styles on the server; do the same here.
    const cells = a.cells.map(([r, c, key]): [number, number, string | null] => {
      if (!b.ranges.some((s) => r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2)) return [r, c, key];
      const base = key === null ? undefined : (JSON.parse(key) as CellStyle);
      return [r, c, styleKey(applyStylePatch(base, b.patch)) ?? null];
    });
    return { ...a, cells };
  }
  return a;
}

function overSetStyles(a: Simple, b: Extract<Op, { type: 'setStyles' }>, aWins: boolean): Op {
  if (aWins || !('sheetId' in a) || a.sheetId !== b.sheetId) return a;
  if (a.type === 'setStyles') {
    const taken = new Set(b.cells.map(([r, c]) => r * MAX_COLS + c));
    const rowsTaken = new Set((b.rows ?? []).map(([i]) => i));
    const colsTaken = new Set((b.cols ?? []).map(([i]) => i));
    const out = {
      ...a,
      cells: a.cells.filter(([r, c]) => !taken.has(r * MAX_COLS + c)),
    };
    if (a.rows) out.rows = a.rows.filter(([i]) => !rowsTaken.has(i));
    if (a.cols) out.cols = a.cols.filter(([i]) => !colsTaken.has(i));
    return out;
  }
  if (a.type === 'formatRanges') {
    const reassert = b.cells.filter(([r, c]) => a.ranges.some((s) => r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2));
    if (reassert.length === 0) return a;
    return {
      type: 'batch',
      ops: [a, { type: 'setStyles', sheetId: a.sheetId, cells: reassert }],
    };
  }
  return a;
}

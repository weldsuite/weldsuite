/**
 * Operational transform for concurrent ops.
 *
 * `transform(op, against, opWins)` returns `op` rewritten to apply after
 * `against`, both made against the same document. Collaboration is
 * server-sequenced, as for WeldSheets, so this one function is all it takes:
 * the room transforms a late batch past what was committed since it was made,
 * and a client rebases its unconfirmed edits on each incoming op with the
 * same call, so every replica runs the same ops in the same order.
 *
 * `opWins` says which op the room applied later; it only breaks ties between
 * two inserts at the same position (the later one goes after the earlier).
 *
 * Only positions need transforming. Everything else is addressed by id
 * (stories, tables, rows and columns for formatting, styles, lists, anchors),
 * so a later write to the same thing simply wins, and an op on something a
 * concurrent op deleted does nothing when applied (see apply.ts).
 */

import type { Anchor, TableAxis } from '../model/objects';
import { NOOP, normalize, runsLength, type FormatRun, type Op, type OpOf, type SimpleOp } from './types';

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

function transformSimple(a: SimpleOp, b: SimpleOp, aWins: boolean): Op {
  switch (b.type) {
    case 'insert':
      return overInsert(a, b.story, b.at, b.content.text.length, aWins);
    case 'delete':
      return overDelete(a, b.story, b.from, b.to);
    case 'insertTableDims':
      return overDimsInsert(a, b, aWins);
    case 'deleteTableDims':
      return overDimsDelete(a, b);
    case 'createStory':
      // Header and footer ids are fixed per section: both sides created the same story.
      return a.type === 'createStory' && a.story === b.story ? NOOP : a;
    case 'deleteStory':
      // Edits to a deleted header must not shift positions in one created again under the same id.
      if (a.type === 'patchAnchors' && a.set?.some((x) => x.story === b.story)) {
        return { ...a, set: a.set.filter((x) => x.story !== b.story) };
      }
      return 'story' in a && a.story === b.story && a.type !== 'createStory' ? NOOP : a;
    default:
      return a;
  }
}

// ---------------------------------------------------------------- positions

/** Where a position goes when `n` characters are inserted at `at`; one exactly at `at` moves when `after`. */
export function mapInsert(p: number, at: number, n: number, after: boolean): number {
  return p > at || (p === at && after) ? p + n : p;
}

/** Where a position goes when [from, to) is deleted; one inside lands on `from`. */
export function mapDelete(p: number, from: number, to: number): number {
  if (p <= from) return p;
  if (p >= to) return p - (to - from);
  return from;
}

function overInsert(a: SimpleOp, story: string, at: number, n: number, aWins: boolean): Op {
  switch (a.type) {
    case 'insert':
      return a.story === story ? { ...a, at: mapInsert(a.at, at, n, aWins) } : a;
    case 'delete':
      return deleteOverInsert(a, story, at, n);
    case 'formatText':
    case 'formatParagraphs': {
      if (a.story !== story) return a;
      if (at <= a.at) return { ...a, at: a.at + n };
      if (at >= a.at + runsLength(a.runs)) return a;
      return { ...a, runs: insertGap(a.runs as FormatRun<unknown>[], at - a.at, n) } as Op;
    }
    case 'setObject':
      return a.story === story && at <= a.at ? { ...a, at: a.at + n } : a;
    case 'patchAnchors':
      // An anchor's start moves past text typed exactly at it; its end does not grow to cover it.
      return moveAnchorsIn(a, story, (p, isEnd) => mapInsert(p, at, n, !isEnd));
    default:
      return a;
  }
}

function deleteOverInsert(a: OpOf<'delete'>, story: string, at: number, n: number): Op {
  if (a.story !== story || at >= a.to) return a;
  if (at <= a.from) return { ...a, from: a.from + n, to: a.to + n };
  // Text typed inside a range someone else deletes survives: delete around it (the later part first).
  return {
    type: 'batch',
    ops: [
      { type: 'delete', story, from: at + n, to: a.to + n },
      { type: 'delete', story, from: a.from, to: at },
    ],
  };
}

function overDelete(a: SimpleOp, story: string, from: number, to: number): Op {
  switch (a.type) {
    case 'insert':
      return a.story === story ? { ...a, at: mapDelete(a.at, from, to) } : a;
    case 'delete':
      return a.story === story ? { ...a, from: mapDelete(a.from, from, to), to: mapDelete(a.to, from, to) } : a;
    case 'formatText':
    case 'formatParagraphs':
      return a.story === story ? formatOverDelete(a, from, to) : a;
    case 'setObject':
      if (a.story !== story) return a;
      if (a.at >= from && a.at < to) return NOOP;
      return { ...a, at: mapDelete(a.at, from, to) };
    case 'patchAnchors':
      return moveAnchorsIn(a, story, (p) => mapDelete(p, from, to));
    default:
      return a;
  }
}

/** A format op past a delete in its story: shifted, with the deleted stretch cut out of its runs. */
function formatOverDelete(a: OpOf<'formatText'> | OpOf<'formatParagraphs'>, from: number, to: number): Op {
  const end = a.at + runsLength(a.runs);
  if (to <= a.at) return { ...a, at: a.at - (to - from) };
  if (from >= end) return a;
  const cutFrom = Math.max(from, a.at) - a.at;
  const cutTo = Math.min(to, end) - a.at;
  return { ...a, at: Math.min(a.at, from), runs: cutRuns(a.runs as FormatRun<unknown>[], cutFrom, cutTo) } as Op;
}

/** Moves the anchors an op sets in `story`; the op comes back as is when it sets none there. */
function moveAnchorsIn(a: OpOf<'patchAnchors'>, story: string, map: (p: number, isEnd: boolean) => number): Op {
  if (!a.set?.some((x) => x.story === story)) return a;
  return { ...a, set: a.set.map((x) => (x.story === story ? moveAnchor(x, map) : x)) };
}

function moveAnchor(anchor: Anchor, map: (p: number, isEnd: boolean) => number): Anchor {
  const from = map(anchor.from, false);
  const to = Math.max(from, map(anchor.to, true));
  return { ...anchor, from, to };
}

/** Runs with `n` untouched characters inserted at `offset` (inside them). */
function insertGap<P>(runs: FormatRun<P>[], offset: number, n: number): FormatRun<P>[] {
  const out: FormatRun<P>[] = [];
  let pos = 0;
  let done = false;
  for (const [len, patch] of runs) {
    if (!done && offset < pos + len) {
      const head = offset - pos;
      if (head > 0) out.push([head, patch]);
      out.push([n, null]);
      out.push([len - head, patch]);
      done = true;
    } else {
      out.push([len, patch]);
    }
    pos += len;
  }
  if (!done) out.push([n, null]);
  return out;
}

/** Runs with [cutFrom, cutTo) (offsets into them) removed. */
function cutRuns<P>(runs: FormatRun<P>[], cutFrom: number, cutTo: number): FormatRun<P>[] {
  const out: FormatRun<P>[] = [];
  let pos = 0;
  for (const [len, patch] of runs) {
    const start = pos;
    const end = pos + len;
    pos = end;
    const keep = len - Math.max(0, Math.min(end, cutTo) - Math.max(start, cutFrom));
    if (keep > 0) out.push([keep, patch]);
  }
  return out;
}

// ---------------------------------------------------------------- tables

function overDimsInsert(a: SimpleOp, b: OpOf<'insertTableDims'>, aWins: boolean): Op {
  if (!sameAxis(a, b.table, b.axis)) return a;
  const n = b.items.length;
  if (a.type === 'insertTableDims') return { ...a, at: mapInsert(a.at, b.at, n, aWins) };
  if (a.type === 'deleteTableDims') {
    const end = a.at + a.count;
    if (b.at >= end) return a;
    if (b.at <= a.at) return { ...a, at: a.at + n };
    // Rows someone else added inside a range being deleted stay.
    return {
      type: 'batch',
      ops: [
        { ...a, at: b.at + n, count: end - b.at },
        { ...a, count: b.at - a.at },
      ],
    };
  }
  return a;
}

function overDimsDelete(a: SimpleOp, b: OpOf<'deleteTableDims'>): Op {
  if (!sameAxis(a, b.table, b.axis)) return a;
  const end = b.at + b.count;
  if (a.type === 'insertTableDims') return { ...a, at: mapDelete(a.at, b.at, end) };
  if (a.type === 'deleteTableDims') {
    const from = mapDelete(a.at, b.at, end);
    const to = mapDelete(a.at + a.count, b.at, end);
    return to > from ? { ...a, at: from, count: to - from } : NOOP;
  }
  return a;
}

function sameAxis(a: SimpleOp, table: string, axis: TableAxis): a is OpOf<'insertTableDims'> | OpOf<'deleteTableDims'> {
  return (a.type === 'insertTableDims' || a.type === 'deleteTableDims') && a.table === table && a.axis === axis;
}

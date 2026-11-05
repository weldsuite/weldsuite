/**
 * `transform(a, b, aWins)`: `a` rewritten to apply after `b`, both made
 * against the same board. The room passes `aWins` true for the op it is
 * committing now and false for the one it committed earlier, so on a real
 * conflict the later op wins.
 *
 * Because the server sequences everything and clients rebase (see
 * @weldsuite/collab), the rules only have to be deterministic and keep ops
 * valid; they need not be symmetric.
 *
 * - Properties conflict per key: two `set`s of one element keep both keys
 *   they don't share; for a shared key the winner's value stays.
 * - An edit of an element `b` deleted becomes a no-op.
 * - Text edits move by position, as in any text OT. Text inserted inside a
 *   range someone else deletes survives: the delete splits around it.
 * - A `set` replacing an element's whole text drops concurrent text edits.
 */

import type { MarksPatch } from '../model/text';
import { NOOP, batch, normalize, type MarksRun, type Op, type OpOf, type SimpleOp } from './types';

export function transform(a: Op, b: Op, aWins: boolean): Op {
  if (b.type === 'batch') {
    let out = a;
    for (const bi of b.ops) out = transform(out, bi, aWins);
    return out;
  }
  if (a.type === 'batch') {
    let against: Op = b;
    const ops = a.ops.map((ai) => {
      const t = transform(ai, against, aWins);
      against = transform(against, ai, !aWins);
      return t;
    });
    return normalize({ type: 'batch', ops });
  }
  return normalize(transformSimple(a, b, aWins));
}

function transformSimple(a: SimpleOp, b: SimpleOp, aWins: boolean): Op {
  switch (b.type) {
    case 'create':
      return afterCreate(a, b);
    case 'delete':
      return afterDelete(a, b);
    case 'set':
      return afterSet(a, b, aWins);
    case 'insertText':
      return afterInsertText(a, b, aWins);
    case 'deleteText':
      return afterDeleteText(a, b);
    case 'formatText':
      return afterFormatText(a, b, aWins);
    case 'setBoard':
      return a.type === 'setBoard' ? withoutKeys(a, b.patch, aWins) : a;
    case 'vote':
      return a.type === 'vote' && a.user === b.user && !aWins ? NOOP : a;
  }
}

function afterCreate(a: SimpleOp, b: OpOf<'create'>): Op {
  if (a.type !== 'create') return a;
  const taken = new Set(b.elements.map((e) => e.id));
  return { type: 'create', elements: a.elements.filter((e) => !taken.has(e.id)) };
}

function afterDelete(a: SimpleOp, b: OpOf<'delete'>): Op {
  const gone = new Set(b.ids);
  switch (a.type) {
    case 'set': {
      if (gone.has(a.id)) return NOOP;
      if (typeof a.patch.parent === 'string' && gone.has(a.patch.parent)) return { ...a, patch: { ...a.patch, parent: null } };
      return a;
    }
    case 'insertText':
    case 'deleteText':
    case 'formatText':
      return gone.has(a.id) ? NOOP : a;
    case 'create':
      return {
        type: 'create',
        elements: a.elements.map((e) => (e.parent && gone.has(e.parent) ? { ...e, parent: null } : e)).map(stripNullParent),
      };
    case 'delete':
      return { type: 'delete', ids: a.ids.filter((id) => !gone.has(id)) };
    default:
      return a;
  }
}

function stripNullParent<T extends { parent?: string | null }>(e: T): T {
  if (e.parent !== null) return e;
  const copy = { ...e };
  delete copy.parent;
  return copy;
}

function withoutKeys<T extends { patch: Record<string, unknown> }>(a: T, taken: Record<string, unknown>, aWins: boolean): T {
  if (aWins) return a;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.patch)) if (!(k in taken)) patch[k] = v;
  return { ...a, patch };
}

function afterSet(a: SimpleOp, b: OpOf<'set'>, aWins: boolean): Op {
  if (!('id' in a) || a.id !== b.id) return a;
  if (a.type === 'set') return withoutKeys(a, b.patch, aWins);
  // The whole text was replaced: positions in the old one mean nothing.
  if ((a.type === 'insertText' || a.type === 'deleteText' || a.type === 'formatText') && 'text' in b.patch) return NOOP;
  return a;
}

function afterInsertText(a: SimpleOp, b: OpOf<'insertText'>, aWins: boolean): Op {
  if (!('id' in a) || a.id !== b.id) return a;
  const len = b.text.text.length;
  switch (a.type) {
    case 'insertText':
      return a.at > b.at || (a.at === b.at && aWins) ? { ...a, at: a.at + len } : a;
    case 'deleteText': {
      if (b.at <= a.from) return { ...a, from: a.from + len, to: a.to + len };
      if (b.at >= a.to) return a;
      // Keep what was typed inside the range: delete around it (the later part first).
      return batch([
        { type: 'deleteText', id: a.id, from: b.at + len, to: a.to + len },
        { type: 'deleteText', id: a.id, from: a.from, to: b.at },
      ]);
    }
    case 'formatText': {
      const end = a.at + runsLength(a.runs);
      if (b.at <= a.at) return { ...a, at: a.at + len };
      if (b.at >= end) return a;
      return { ...a, runs: insertGap(a.runs, b.at - a.at, len) };
    }
    default:
      return a;
  }
}

function mapPos(p: number, from: number, to: number): number {
  if (p <= from) return p;
  if (p >= to) return p - (to - from);
  return from;
}

function afterDeleteText(a: SimpleOp, b: OpOf<'deleteText'>): Op {
  if (!('id' in a) || a.id !== b.id) return a;
  switch (a.type) {
    case 'insertText':
      return { ...a, at: mapPos(a.at, b.from, b.to) };
    case 'deleteText': {
      const from = mapPos(a.from, b.from, b.to);
      const to = mapPos(a.to, b.from, b.to);
      return from >= to ? NOOP : { ...a, from, to };
    }
    case 'formatText': {
      const end = a.at + runsLength(a.runs);
      const cutFrom = Math.max(a.at, b.from);
      const cutTo = Math.min(end, b.to);
      const runs = cutTo > cutFrom ? cutRuns(a.runs, cutFrom - a.at, cutTo - a.at) : a.runs;
      return { ...a, at: mapPos(a.at, b.from, b.to), runs };
    }
    default:
      return a;
  }
}

function afterFormatText(a: SimpleOp, b: OpOf<'formatText'>, aWins: boolean): Op {
  if (a.type !== 'formatText' || a.id !== b.id || aWins) return a;
  // Where both format the same characters, the earlier op keeps its keys.
  const theirs = expand(b.runs, b.at);
  const runs: MarksRun[] = [];
  let pos = a.at;
  for (const [len, patch] of a.runs) {
    for (let i = 0; i < len; i++, pos++) {
      if (!patch) {
        runs.push([1, null]);
        continue;
      }
      const taken = theirs.get(pos);
      if (!taken) {
        runs.push([1, patch]);
        continue;
      }
      const rest: MarksPatch = {};
      for (const [k, v] of Object.entries(patch)) if (!(k in taken)) (rest as Record<string, unknown>)[k] = v;
      runs.push([1, Object.keys(rest).length ? rest : null]);
    }
  }
  return { ...a, runs: mergeRuns(runs) };
}

export function runsLength(runs: MarksRun[]): number {
  let n = 0;
  for (const [len] of runs) n += len;
  return n;
}

/** Per position, the patch a run list applies there. */
function expand(runs: MarksRun[], at: number): Map<number, MarksPatch> {
  const out = new Map<number, MarksPatch>();
  let pos = at;
  for (const [len, patch] of runs) {
    if (patch) for (let i = 0; i < len; i++) out.set(pos + i, patch);
    pos += len;
  }
  return out;
}

function mergeRuns(runs: MarksRun[]): MarksRun[] {
  const out: MarksRun[] = [];
  for (const [len, patch] of runs) {
    if (len <= 0) continue;
    const last = out.at(-1);
    if (last && JSON.stringify(last[1]) === JSON.stringify(patch)) last[0] += len;
    else out.push([len, patch]);
  }
  return out;
}

/** Inserts an untouched stretch of `len` at `offset` into a run list. */
function insertGap(runs: MarksRun[], offset: number, len: number): MarksRun[] {
  const out: MarksRun[] = [];
  let pos = 0;
  let done = false;
  for (const [n, patch] of runs) {
    if (!done && offset < pos + n) {
      const before = offset - pos;
      if (before > 0) out.push([before, patch]);
      out.push([len, null]);
      out.push([n - before, patch]);
      done = true;
    } else out.push([n, patch]);
    pos += n;
  }
  if (!done) out.push([len, null]);
  return mergeRuns(out);
}

/** Removes [from, to) (offsets into the runs) from a run list. */
function cutRuns(runs: MarksRun[], from: number, to: number): MarksRun[] {
  const out: MarksRun[] = [];
  let pos = 0;
  for (const [n, patch] of runs) {
    const start = pos;
    const end = pos + n;
    const keep = n - Math.max(0, Math.min(end, to) - Math.max(start, from));
    if (keep > 0) out.push([keep, patch]);
    pos = end;
  }
  return mergeRuns(out);
}

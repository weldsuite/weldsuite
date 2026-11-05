/**
 * Rich text inside elements: a string plus mark runs. Edited by position
 * (insert, delete, format), so two people typing in one sticky merge by
 * character (ops/transform.ts).
 *
 * Every function here returns new values and never mutates its input.
 */

import type { MarkRun, Marks, RichText } from './types';

/** A change to marks: a value sets that mark, null removes it. */
export type MarksPatch = { [K in keyof Marks]?: Marks[K] | null };

export const MARK_KEYS = ['b', 'i', 'u', 's', 'c', 'h', 'a', 'm'] as const satisfies readonly (keyof Marks)[];

export const MAX_TEXT = 20_000;

export function plain(text = ''): RichText {
  return { text, marks: [] };
}

export function isEmptyMarks(m: Marks): boolean {
  return Object.keys(m).length === 0;
}

export function sameMarks(a: Marks, b: Marks): boolean {
  for (const k of MARK_KEYS) if (a[k] !== b[k]) return false;
  return true;
}

/** Runs covering `length` characters, merged, with zero-length runs dropped. [] when nothing is formatted. */
export function normalizeRuns(runs: MarkRun[], length: number): MarkRun[] {
  const out: MarkRun[] = [];
  let covered = 0;
  for (const [len, marks] of runs) {
    const n = Math.min(len, length - covered);
    if (n <= 0) continue;
    covered += n;
    const last = out.at(-1);
    if (last && sameMarks(last[1], marks)) last[0] += n;
    else out.push([n, { ...marks }]);
  }
  if (covered < length) {
    const last = out.at(-1);
    if (last && isEmptyMarks(last[1])) last[0] += length - covered;
    else out.push([length - covered, {}]);
  }
  return out.every(([, m]) => isEmptyMarks(m)) ? [] : out;
}

/** Runs covering the whole text (an unformatted text gets one empty run). */
export function fullRuns(rt: RichText): MarkRun[] {
  if (rt.text.length === 0) return [];
  return rt.marks.length ? rt.marks.map(([n, m]) => [n, { ...m }] as MarkRun) : [[rt.text.length, {}]];
}

export function normalizeRich(rt: RichText): RichText {
  return { text: rt.text, marks: normalizeRuns(rt.marks, rt.text.length) };
}

/** The marks at `pos` (of the character before it, as typing continues them). */
export function marksAt(rt: RichText, pos: number): Marks {
  const at = Math.max(0, pos - 1);
  let start = 0;
  for (const [len, marks] of rt.marks) {
    if (at < start + len) return { ...marks };
    start += len;
  }
  return {};
}

export function sliceRich(rt: RichText, from: number, to: number): RichText {
  const text = rt.text.slice(from, to);
  const runs: MarkRun[] = [];
  let start = 0;
  for (const [len, marks] of rt.marks) {
    const a = Math.max(start, from);
    const b = Math.min(start + len, to);
    if (b > a) runs.push([b - a, { ...marks }]);
    start += len;
  }
  return { text, marks: normalizeRuns(runs, text.length) };
}

export function concatRich(...parts: RichText[]): RichText {
  let text = '';
  const runs: MarkRun[] = [];
  for (const p of parts) {
    text += p.text;
    runs.push(...fullRuns(p));
  }
  return { text, marks: normalizeRuns(runs, text.length) };
}

export function insertRich(rt: RichText, at: number, insert: RichText): RichText {
  return concatRich(sliceRich(rt, 0, at), insert, sliceRich(rt, at, rt.text.length));
}

export function deleteRich(rt: RichText, from: number, to: number): RichText {
  return concatRich(sliceRich(rt, 0, from), sliceRich(rt, to, rt.text.length));
}

function patchMarks(marks: Marks, patch: MarksPatch): Marks {
  const out: Marks = { ...marks };
  for (const k of MARK_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) delete out[k];
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** The patch that undoes `patch` on `marks`. */
function revertPatch(marks: Marks, patch: MarksPatch): MarksPatch {
  const out: MarksPatch = {};
  for (const k of MARK_KEYS) {
    if (!(k in patch)) continue;
    (out as Record<string, unknown>)[k] = marks[k] ?? null;
  }
  return out;
}

/**
 * Applies format runs (`[length, patch | null]`) from `at` on. Returns the
 * new text and the runs that undo it.
 */
export function formatRich(
  rt: RichText,
  at: number,
  runs: [number, MarksPatch | null][],
): { text: RichText; inverse: [number, MarksPatch | null][] } {
  const chars = fullRuns(rt).flatMap(([n, m]) => Array.from({ length: n }, () => m));
  const inverse: [number, MarksPatch | null][] = [];
  let pos = at;
  for (const [len, patch] of runs) {
    if (!patch) {
      inverse.push([len, null]);
      pos += len;
      continue;
    }
    for (let i = 0; i < len && pos < chars.length; i++, pos++) {
      const before = chars[pos] ?? {};
      inverse.push([1, revertPatch(before, patch)]);
      chars[pos] = patchMarks(before, patch);
    }
  }
  const out: MarkRun[] = chars.map((m) => [1, m]);
  return { text: { text: rt.text, marks: normalizeRuns(out, rt.text.length) }, inverse: mergePatchRuns(inverse) };
}

function samePatch(a: MarksPatch | null, b: MarksPatch | null): boolean {
  if (a === null || b === null) return a === b;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export function mergePatchRuns(runs: [number, MarksPatch | null][]): [number, MarksPatch | null][] {
  const out: [number, MarksPatch | null][] = [];
  for (const [len, patch] of runs) {
    if (len <= 0) continue;
    const last = out.at(-1);
    if (last && samePatch(last[1], patch)) last[0] += len;
    else out.push([len, patch ? { ...patch } : null]);
  }
  return out;
}

export function plainText(rt: RichText | undefined): string {
  return rt?.text ?? '';
}

/** Paragraphs as [start, end) offsets, end excluding the `\n`. */
export function paragraphRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      out.push([start, text.length]);
      return out;
    }
    out.push([start, nl]);
    start = nl + 1;
  }
}

/** Splits a UTF-16 surrogate pair at `pos`? Positions must not. */
export function splitsSurrogate(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false;
  const code = text.charCodeAt(pos);
  return code >= 0xdc00 && code <= 0xdfff;
}

const MARK_TYPES: Record<keyof Marks, 'flag' | 'string'> = {
  b: 'flag',
  i: 'flag',
  u: 'flag',
  s: 'flag',
  c: 'string',
  h: 'string',
  a: 'string',
  m: 'string',
};

export function isMarks(v: unknown): v is Marks {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    const kind = MARK_TYPES[k as keyof Marks];
    if (!kind) return false;
    if (kind === 'flag' ? val !== true : typeof val !== 'string' || val.length > 2048) return false;
  }
  return true;
}

export function isMarksPatch(v: unknown): v is MarksPatch {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    const kind = MARK_TYPES[k as keyof Marks];
    if (!kind) return false;
    if (val === null) continue;
    if (kind === 'flag' ? val !== true : typeof val !== 'string' || val.length > 2048) return false;
  }
  return true;
}

export function isRichText(v: unknown): v is RichText {
  if (typeof v !== 'object' || v === null) return false;
  const rt = v as Record<string, unknown>;
  if (typeof rt.text !== 'string' || rt.text.length > MAX_TEXT || !Array.isArray(rt.marks)) return false;
  if (Object.keys(rt).some((k) => k !== 'text' && k !== 'marks')) return false;
  let total = 0;
  for (const run of rt.marks) {
    if (!Array.isArray(run) || run.length !== 2 || !Number.isInteger(run[0]) || (run[0] as number) < 0 || !isMarks(run[1])) return false;
    total += run[0] as number;
  }
  return rt.marks.length === 0 || total === rt.text.length;
}

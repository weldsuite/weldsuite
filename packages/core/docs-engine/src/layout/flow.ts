/**
 * A story's paragraphs as layout sees them: where each one is, and its cached
 * layout. Edits shift the entries after them and re-scan only the paragraphs
 * they touch; everything else keeps its layout.
 *
 * When a story changed without the layout being told (a remote edit applied
 * under unconfirmed local ones), `rebuild` re-scans it and reuses the layout
 * of every paragraph whose content is unchanged.
 */

import { PARA } from '../model/chars';
import type { Story } from '../model/story';
import type { ParaEntry } from './types';

let nextAttrId = 1;
const attrIds = new WeakMap<object, number>();

function attrId(attr: object): number {
  let id = attrIds.get(attr);
  if (id === undefined) {
    id = nextAttrId++;
    attrIds.set(attr, id);
  }
  return id;
}

export class StoryFlow {
  entries: ParaEntry[] = [];
  /** Story version the entries match. */
  version = -1;

  constructor(readonly storyId: string) {}

  /** Re-scans the whole story, keeping layouts of paragraphs whose content did not change. */
  rebuild(story: Story): void {
    const reuse = new Map<string, ParaEntry[]>();
    for (const e of this.entries) {
      if (!e.layout || !e.content) continue;
      const list = reuse.get(e.content);
      if (list) list.push(e);
      else reuse.set(e.content, [e]);
    }
    this.entries = scan(story, 0, story.length - 1);
    if (reuse.size) {
      for (const e of this.entries) {
        e.content = contentKey(story, e.start, e.end);
        const old = reuse.get(e.content)?.shift();
        if (old) {
          e.layout = old.layout;
          e.key = old.key;
        }
      }
    }
    this.version = story.version;
  }

  /** Index of the entry holding `pos` (start <= pos <= end). */
  indexAt(pos: number): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid]!.end < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** `n` characters were inserted at `at` (the story already holds them). */
  inserted(story: Story, at: number, n: number): void {
    const i = this.indexAt(at);
    const old = this.entries[i];
    if (!old) return this.rebuild(story);
    const fresh = scan(story, old.start, old.end + n);
    for (let k = i + 1; k < this.entries.length; k++) shift(this.entries[k]!, n);
    this.entries.splice(i, 1, ...fresh);
    this.version = story.version;
  }

  /** [from, to) was deleted (the story no longer holds it). */
  deleted(story: Story, from: number, to: number): void {
    const i = this.indexAt(from);
    const j = this.indexAt(to);
    const first = this.entries[i];
    const last = this.entries[j];
    if (!first || !last) return this.rebuild(story);
    const n = to - from;
    const fresh = scan(story, first.start, last.end - n);
    for (let k = j + 1; k < this.entries.length; k++) shift(this.entries[k]!, -n);
    this.entries.splice(i, j - i + 1, ...fresh);
    this.version = story.version;
  }

  /** Paragraphs overlapping [from, to] must be laid out again. */
  dirty(story: Story, from: number, to: number): void {
    for (let k = this.indexAt(from); k < this.entries.length && this.entries[k]!.start <= to; k++) this.entries[k]!.layout = null;
    this.version = story.version;
  }
}

function shift(e: ParaEntry, n: number): void {
  e.start += n;
  e.end += n;
}

/** Entries for the paragraphs in [from, to], where `to` is a paragraph mark. */
function scan(story: Story, from: number, to: number): ParaEntry[] {
  const out: ParaEntry[] = [];
  let start = from;
  for (let p = story.indexOf(PARA, from); p >= 0 && p <= to; p = story.indexOf(PARA, p + 1)) {
    out.push({ start, end: p, layout: null, key: '' });
    start = p + 1;
  }
  return out;
}

/** Everything a paragraph's layout depends on inside its own story. */
export function contentKey(story: Story, start: number, end: number): string {
  let key = story.text(start, end + 1);
  story.forEachRun(start, end + 1, (s, e, id) => {
    key += `|${e - s}:${id}`;
  });
  story.forEachAttr(start, end + 1, (p, attr) => {
    key += `|${p - start}#${attrId(attr)}`;
  });
  return key;
}

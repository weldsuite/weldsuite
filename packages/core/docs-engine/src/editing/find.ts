/**
 * Find and replace, word count, and walking a document's stories in reading
 * order (body, the cells of its tables as they come, footnotes, then
 * headers and footers).
 */

import { OBJECT, PARA } from '../model/chars';
import type { DocModel } from '../model/document';
import { cellStoryId, footnoteStoryId, headerSection, type ObjectData } from '../model/objects';
import { BODY } from '../model/objects';
import { batch, type Op } from '../ops/types';
import { replaceRange } from './commands';

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  /** `query` is a regular expression. */
  regex?: boolean;
}

export interface Match {
  story: string;
  from: number;
  to: number;
}

/** Story ids in reading order. */
export function storiesInOrder(doc: DocModel): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const footnotes: string[] = [];
  const visit = (id: string) => {
    const story = doc.stories.get(id);
    if (!story || seen.has(id)) return;
    seen.add(id);
    out.push(id);
    story.forEachAttr(0, story.length, (pos, attr) => {
      if (story.charAt(pos) !== OBJECT) return;
      const obj = attr as ObjectData;
      if (obj.kind === 'table') {
        const t = doc.tables.get(obj.id);
        if (t) for (const r of t.rows) for (const c of t.cols) visit(cellStoryId(obj.id, r.id, c.id));
      } else if (obj.kind === 'footnote') footnotes.push(footnoteStoryId(obj.id));
    });
  };
  visit(BODY);
  for (const f of footnotes) visit(f);
  for (const id of [...doc.stories.keys()].sort()) if (headerSection(id)) visit(id);
  return out;
}

/** A RegExp for the query, or null when it is empty or not a valid expression. */
export function queryPattern(query: string, options: FindOptions = {}): RegExp | null {
  if (!query) return null;
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${options.matchCase ? '' : 'i'}`);
  } catch {
    return null;
  }
}

/** Every match in the document, in reading order. Matches never span paragraphs or objects. */
export function findAll(doc: DocModel, query: string, options: FindOptions = {}, limit = 10_000): Match[] {
  const pattern = queryPattern(query, options);
  if (!pattern) return [];
  const out: Match[] = [];
  for (const id of storiesInOrder(doc)) {
    const text = doc.stories.get(id)!.text();
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      if (m[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      if (!m[0].includes(PARA) && !m[0].includes(OBJECT)) out.push({ story: id, from: m.index, to: m.index + m[0].length });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * One op replacing every match with `replacement` (for a regular
 * expression, `$1` and friends refer to its groups). Matches are replaced
 * last to first within each story, so earlier positions stay valid.
 */
export function replaceAll(doc: DocModel, query: string, replacement: string, options: FindOptions = {}): { op: Op; count: number } {
  const matches = findAll(doc, query, options);
  const pattern = options.regex ? queryPattern(query, options) : null;
  const ops: Op[] = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    let text = replacement;
    if (pattern) {
      const source = doc.stories.get(m.story)!.text(m.from, m.to);
      pattern.lastIndex = 0;
      text = source.replace(pattern, replacement);
    }
    ops.push(replaceRange(doc, m.story, m.from, m.to, text));
  }
  return { op: batch(ops), count: matches.length };
}

const WORD = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

export interface DocumentStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
}

/** Counts over text (body only unless `stories` says otherwise), as the word count dialog shows them. */
export function textStats(text: string): DocumentStats {
  const visible = text.replace(new RegExp(`[${OBJECT}]`, 'g'), '');
  const paragraphs = visible.split(PARA).filter((p) => p.trim().length > 0).length;
  const chars = visible.replace(new RegExp(PARA, 'g'), '');
  return {
    words: countWords(visible),
    characters: [...chars].length,
    charactersNoSpaces: [...chars.replace(/\s/g, '')].length,
    paragraphs,
  };
}

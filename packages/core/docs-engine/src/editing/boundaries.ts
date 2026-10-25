/**
 * Text boundaries for caret movement and deletion: characters as the user
 * sees them (graphemes: an emoji with its modifiers, a letter with its
 * accents), words, and paragraphs.
 */

import { OBJECT, PARA } from '../model/chars';
import type { Story } from '../model/story';

type Segmenter = { segment(text: string): Iterable<{ index: number; segment: string; isWordLike?: boolean }> };

let graphemes: Segmenter | null | undefined;
let words: Segmenter | null | undefined;

function segmenter(granularity: 'grapheme' | 'word'): Segmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
  if (!Ctor) return null;
  if (granularity === 'grapheme') {
    graphemes ??= new Ctor(undefined, { granularity });
    return graphemes;
  }
  words ??= new Ctor(undefined, { granularity });
  return words;
}

/** How far context reaches around a position when finding boundaries. */
const WINDOW = 64;

/** Position of the next (dir 1) or previous (dir -1) grapheme boundary from `pos`. */
export function nextGrapheme(story: Story, pos: number, dir: 1 | -1): number {
  if (dir > 0 && pos >= story.length) return story.length;
  if (dir < 0 && pos <= 0) return 0;
  const from = Math.max(0, pos - WINDOW);
  const to = Math.min(story.length, pos + WINDOW);
  const text = story.text(from, to);
  const seg = segmenter('grapheme');
  const local = pos - from;
  // Without a segmenter, code points at least: never split a surrogate pair.
  if (!seg) return pos + dir * codePointLength(text, local, dir);
  return from + (dir > 0 ? graphemeEndAfter(seg, text, local) : graphemeStartBefore(seg, text, local));
}

/** Length of the code point after (dir 1) or before (dir -1) offset `local`: 2 for a surrogate pair. */
function codePointLength(text: string, local: number, dir: 1 | -1): number {
  if (dir > 0) {
    const c = text.charCodeAt(local);
    return c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  const c = text.charCodeAt(local - 1);
  return c >= 0xdc00 && c <= 0xdfff ? 2 : 1;
}

/** End of the grapheme holding offset `local` (the text's end when there is none). */
function graphemeEndAfter(seg: Segmenter, text: string, local: number): number {
  for (const s of seg.segment(text)) {
    const end = s.index + s.segment.length;
    if (end > local) return end;
  }
  return text.length;
}

/** Start of the last grapheme before offset `local`. */
function graphemeStartBefore(seg: Segmenter, text: string, local: number): number {
  let before = 0;
  for (const s of seg.segment(text)) {
    if (s.index >= local) break;
    before = s.index;
  }
  return before;
}

/**
 * The next word boundary in `dir`, as Ctrl+Arrow moves: forward to the end
 * of the next word, backward to the start of the previous one. Paragraph
 * marks and objects are boundaries of their own.
 */
export function nextWord(story: Story, pos: number, dir: 1 | -1): number {
  const from = Math.max(0, pos - 256);
  const to = Math.min(story.length, pos + 256);
  const text = story.text(from, to);
  const local = pos - from;
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}\p{M}_'’]/u.test(ch);
  const hard = (ch: string | undefined) => ch === PARA || ch === OBJECT;
  let i = local;
  if (dir > 0) {
    if (hard(text[i])) return from + i + 1;
    while (i < text.length && !isWordChar(text[i]) && !hard(text[i])) i++;
    while (i < text.length && isWordChar(text[i])) i++;
    return Math.min(story.length, from + i);
  }
  if (hard(text[i - 1])) return from + i - 1;
  while (i > 0 && !isWordChar(text[i - 1]) && !hard(text[i - 1])) i--;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return from + i;
}

/** The word around `pos` (for a double click): [start, end), or the single character there. */
export function wordAt(story: Story, pos: number): { from: number; to: number } {
  const from = Math.max(0, pos - 256);
  const to = Math.min(story.length, pos + 256);
  const text = story.text(from, to);
  const seg = segmenter('word');
  const local = pos - from;
  const segment = seg ? segmentAt(seg, text, local) : null;
  if (segment) return { from: from + segment.from, to: from + segment.to };
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}\p{M}_]/u.test(ch);
  let a = local;
  let b = local;
  while (a > 0 && isWordChar(text[a - 1])) a--;
  while (b < text.length && isWordChar(text[b])) b++;
  if (a === b) return { from: pos, to: Math.min(pos + 1, story.length - 1) };
  return { from: from + a, to: from + b };
}

/** The segment holding offset `local`, unless it is a paragraph mark. */
function segmentAt(seg: Segmenter, text: string, local: number): { from: number; to: number } | null {
  for (const s of seg.segment(text)) {
    const end = s.index + s.segment.length;
    if (s.index <= local && local < end) return s.segment === PARA ? null : { from: s.index, to: end };
  }
  return null;
}

/** Start of the paragraph holding `pos`, and the position of its mark. */
export function paragraphAt(story: Story, pos: number): { start: number; end: number } {
  const start = story.lastIndexOf(PARA, pos - 1) + 1;
  const end = story.indexOf(PARA, pos);
  return { start, end: end < 0 ? story.length - 1 : end };
}

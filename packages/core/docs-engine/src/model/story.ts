/**
 * One story's text: the body, a table cell, a header, a footnote.
 *
 * Characters live in chunks of at most `MAX_CHUNK` code units, each with a
 * style id per character and the paragraph/object data of the characters
 * that have any. Chunk start offsets are prefix sums kept valid lazily, so
 * finding a position is a binary search and an edit touches one or two
 * chunks: O(log n) lookups and O(chunk) edits on a document of any length.
 */

import { OBJECT, PARA } from './chars';
import type { ObjectData } from './objects';
import type { ParaProps } from './styles';

export type Attr = ParaProps | ObjectData;

const MAX_CHUNK = 1024;

interface Chunk {
  text: string;
  styles: number[];
  /** Data of paragraph marks and objects, by offset in the chunk. */
  attrs: Map<number, Attr> | null;
}

/** A piece of a story taken out of it (or to put into it). Attr offsets are relative to `text`. */
export interface StoryPiece {
  text: string;
  styles: number[];
  attrs: Map<number, Attr>;
}

export class Story {
  private chunks: Chunk[] = [{ text: '', styles: [], attrs: null }];
  private starts: number[] = [0];
  /** `starts[0..validTo]` are correct; later ones are recomputed on demand. */
  private validTo = 0;
  length = 0;
  /** Bumped on every change, so caches (layout) can tell the story changed. */
  version = 0;

  constructor(readonly id: string) {}

  static from(id: string, piece: StoryPiece): Story {
    const story = new Story(id);
    story.insert(0, piece);
    story.version = 0;
    return story;
  }

  // ---------------------------------------------------------------- reading

  text(from = 0, to = this.length): string {
    if (from >= to) return '';
    let out = '';
    this.walk(from, to, (chunk, start, end) => {
      out += chunk.text.slice(start, end);
    });
    return out;
  }

  charAt(pos: number): string {
    if (pos < 0 || pos >= this.length) return '';
    const [ci, off] = this.locate(pos, false);
    return this.chunks[ci]!.text[off]!;
  }

  styleAt(pos: number): number {
    if (pos < 0 || pos >= this.length) return 0;
    const [ci, off] = this.locate(pos, false);
    return this.chunks[ci]!.styles[off]!;
  }

  attrAt(pos: number): Attr | undefined {
    if (pos < 0 || pos >= this.length) return undefined;
    const [ci, off] = this.locate(pos, false);
    return this.chunks[ci]!.attrs?.get(off);
  }

  paraAt(pos: number): ParaProps | undefined {
    return this.charAt(pos) === PARA ? (this.attrAt(pos) as ParaProps | undefined) : undefined;
  }

  objectAt(pos: number): ObjectData | undefined {
    return this.charAt(pos) === OBJECT ? (this.attrAt(pos) as ObjectData | undefined) : undefined;
  }

  /** Copy of [from, to). */
  slice(from: number, to: number): StoryPiece {
    const piece: StoryPiece = { text: '', styles: [], attrs: new Map() };
    if (from >= to) return piece;
    this.walk(from, to, (chunk, start, end) => {
      const at = piece.text.length;
      piece.text += chunk.text.slice(start, end);
      for (let i = start; i < end; i++) piece.styles.push(chunk.styles[i]!);
      if (chunk.attrs) for (const [o, a] of chunk.attrs) if (o >= start && o < end) piece.attrs.set(at + o - start, a);
    });
    return piece;
  }

  /** First position >= `from` holding `ch`, or -1. */
  indexOf(ch: string, from = 0): number {
    if (from >= this.length) return -1;
    let found = -1;
    this.walk(Math.max(0, from), this.length, (chunk, start, end, base) => {
      if (found >= 0) return;
      const i = chunk.text.indexOf(ch, start);
      if (i >= 0 && i < end) found = base + i;
    });
    return found;
  }

  /** Last position <= `from` holding `ch`, or -1. */
  lastIndexOf(ch: string, from = this.length - 1): number {
    if (from < 0) return -1;
    from = Math.min(from, this.length - 1);
    let [ci, off] = this.locate(from, false);
    for (; ci >= 0; ci--) {
      const chunk = this.chunks[ci]!;
      const i = chunk.text.lastIndexOf(ch, off);
      if (i >= 0) return this.startOf(ci) + i;
      off = (this.chunks[ci - 1]?.text.length ?? 0) - 1;
    }
    return -1;
  }

  /** Calls `fn` for each character with data in [from, to), in order. */
  forEachAttr(from: number, to: number, fn: (pos: number, attr: Attr) => void): void {
    this.walk(from, to, (chunk, start, end, base) => {
      if (!chunk.attrs) return;
      const offsets = [...chunk.attrs.keys()].filter((o) => o >= start && o < end).sort((a, b) => a - b);
      for (const o of offsets) fn(base + o, chunk.attrs.get(o)!);
    });
  }

  /** Runs of equal style id over [from, to). */
  forEachRun(from: number, to: number, fn: (start: number, end: number, styleId: number) => void): void {
    let runStart = from;
    let runStyle = -1;
    this.walk(from, to, (chunk, start, end, base) => {
      for (let i = start; i < end; i++) {
        const s = chunk.styles[i]!;
        if (s !== runStyle) {
          if (runStyle >= 0) fn(runStart, base + i, runStyle);
          runStart = base + i;
          runStyle = s;
        }
      }
    });
    if (runStyle >= 0) fn(runStart, to, runStyle);
  }

  // ---------------------------------------------------------------- writing

  insert(pos: number, piece: StoryPiece): void {
    if (piece.text.length === 0) return;
    if (piece.styles.length !== piece.text.length) throw new Error('Style count does not match text length');
    const [ci, off] = this.locate(pos, true);
    const chunk = this.chunks[ci]!;
    const text = chunk.text.slice(0, off) + piece.text + chunk.text.slice(off);
    const styles = chunk.styles.slice(0, off).concat(piece.styles, chunk.styles.slice(off));
    const attrs = new Map<number, Attr>();
    if (chunk.attrs) for (const [o, a] of chunk.attrs) attrs.set(o < off ? o : o + piece.text.length, a);
    for (const [o, a] of piece.attrs) attrs.set(off + o, a);
    this.replaceChunk(ci, { text, styles, attrs: attrs.size ? attrs : null });
    this.length += piece.text.length;
    this.version++;
  }

  /** Removes [from, to) and returns it. */
  remove(from: number, to: number): StoryPiece {
    const removed = this.slice(from, to);
    if (from >= to) return removed;
    const [c1, o1] = this.locate(from, false);
    const [c2, o2] = this.locate(to, true);
    const first = this.chunks[c1]!;
    const last = this.chunks[c2]!;
    const merged = joinChunks(first, o1, last, o2);
    this.chunks.splice(c1, c2 - c1 + 1, merged);
    this.starts.splice(c1 + 1, c2 - c1);
    this.validTo = Math.min(this.validTo, c1);
    if (merged.text.length === 0 && this.chunks.length > 1) this.dropChunk(c1);
    this.length -= to - from;
    this.version++;
    return removed;
  }

  /** Rewrites the style ids of [from, to); `fn` gets the old id and the position. */
  mapStyles(from: number, to: number, fn: (styleId: number, pos: number) => number): void {
    if (from >= to) return;
    this.walk(from, to, (chunk, start, end, base) => {
      for (let i = start; i < end; i++) chunk.styles[i] = fn(chunk.styles[i]!, base + i);
    });
    this.version++;
  }

  setAttr(pos: number, attr: Attr): void {
    const [ci, off] = this.locate(pos, false);
    const chunk = this.chunks[ci]!;
    if (!chunk.attrs) chunk.attrs = new Map();
    chunk.attrs.set(off, attr);
    this.version++;
  }

  // ---------------------------------------------------------------- internals

  private startOf(ci: number): number {
    if (ci > this.validTo) {
      for (let i = this.validTo + 1; i <= ci; i++) this.starts[i] = this.starts[i - 1]! + this.chunks[i - 1]!.text.length;
      this.validTo = ci;
    }
    return this.starts[ci]!;
  }

  /**
   * Chunk index and offset of `pos`. A position on a chunk boundary is the
   * end of the earlier chunk when `atEnd` (where an insert goes), else the
   * start of the later one (where a character is read).
   */
  private locate(pos: number, atEnd: boolean): [number, number] {
    if (pos < 0 || pos > this.length) throw new RangeError(`Position ${pos} is outside the story (length ${this.length})`);
    const last = this.chunks.length - 1;
    this.startOf(last);
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const start = this.starts[mid]!;
      if (start < pos || (!atEnd && start === pos)) lo = mid;
      else hi = mid - 1;
    }
    // Skip empty chunks when reading.
    while (!atEnd && lo < last && pos - this.starts[lo]! >= this.chunks[lo]!.text.length) lo++;
    return [lo, pos - this.starts[lo]!];
  }

  /** Removes the (empty) chunk `ci`; a story always keeps at least one chunk. */
  private dropChunk(ci: number): void {
    this.chunks.splice(ci, 1);
    this.starts.splice(ci, 1);
    this.starts[0] = 0;
    this.validTo = Math.max(0, Math.min(this.validTo, ci - 1));
  }

  private replaceChunk(ci: number, chunk: Chunk): void {
    if (chunk.text.length <= MAX_CHUNK) {
      this.chunks[ci] = chunk;
      this.validTo = Math.min(this.validTo, ci);
      return;
    }
    const pieces = splitChunk(chunk);
    this.chunks.splice(ci, 1, ...pieces);
    this.starts.splice(ci + 1, 0, ...new Array<number>(pieces.length - 1).fill(0));
    this.validTo = Math.min(this.validTo, ci);
  }

  /** Visits the chunk slices covering [from, to): chunk, start/end offsets in it, and the chunk's story offset. */
  private walk(from: number, to: number, fn: (chunk: Chunk, start: number, end: number, base: number) => void): void {
    if (from >= to) return;
    let [ci, off] = this.locate(from, false);
    let pos = from;
    while (pos < to && ci < this.chunks.length) {
      const chunk = this.chunks[ci]!;
      const base = this.startOf(ci);
      const end = Math.min(chunk.text.length, to - base);
      if (end > off) fn(chunk, off, end, base);
      pos = base + chunk.text.length;
      ci++;
      off = 0;
    }
  }
}

/** `first` up to `o1` followed by `last` from `o2`: what is left of a removal spanning them. */
function joinChunks(first: Chunk, o1: number, last: Chunk, o2: number): Chunk {
  const text = first.text.slice(0, o1) + last.text.slice(o2);
  const styles = first.styles.slice(0, o1).concat(last.styles.slice(o2));
  const attrs = new Map<number, Attr>();
  if (first.attrs) for (const [o, a] of first.attrs) if (o < o1) attrs.set(o, a);
  if (last.attrs) for (const [o, a] of last.attrs) if (o >= o2) attrs.set(o1 + o - o2, a);
  return { text, styles, attrs: attrs.size ? attrs : null };
}

/** Cuts an oversized chunk into half-size pieces, never splitting a surrogate pair. */
function splitChunk(chunk: Chunk): Chunk[] {
  const pieces: Chunk[] = [];
  const size = MAX_CHUNK >> 1;
  let start = 0;
  while (start < chunk.text.length) {
    let end = Math.min(chunk.text.length, start + size);
    const code = chunk.text.charCodeAt(end - 1);
    if (end < chunk.text.length && code >= 0xd800 && code <= 0xdbff) end++;
    pieces.push(chunkSlice(chunk, start, end));
    start = end;
  }
  return pieces;
}

/** Copy of [start, end) of a chunk, attribute offsets made relative to `start`. */
function chunkSlice(chunk: Chunk, start: number, end: number): Chunk {
  const attrs = new Map<number, Attr>();
  if (chunk.attrs) for (const [o, a] of chunk.attrs) if (o >= start && o < end) attrs.set(o - start, a);
  return { text: chunk.text.slice(start, end), styles: chunk.styles.slice(start, end), attrs: attrs.size ? attrs : null };
}

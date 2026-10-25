/**
 * Content as plain JSON: what an insert op carries, what a delete's inverse
 * gives back, what the clipboard holds and what a snapshot stores per story.
 */

import { OBJECT, PARA } from './chars';
import type { ObjectData, TableData } from './objects';
import type { Attr, StoryPiece } from './story';
import type { ParaProps, TextStyle, TextStyleTable } from './styles';
import { isEmptyObject } from './styles';

/** The text of one story (or part of one) with its formatting. */
export interface StoryContent {
  text: string;
  /** `[length, style]` runs from the start of `text`; text past the last run has no direct formatting. */
  runs?: [number, TextStyle][];
  /** Properties of the paragraph marks in `text`, by offset; a mark not listed has none. */
  paras?: [number, ParaProps][];
  /** Data of every object character in `text`, by offset. */
  objects?: [number, ObjectData][];
}

/**
 * Story content plus what its objects own: the tables of its table objects
 * and the stories of their cells, footnotes and section headers, all the way
 * down (a cell holding a table holds that table's cells too).
 */
export interface Content extends StoryContent {
  tables?: Record<string, TableData>;
  stories?: Record<string, StoryContent>;
}

export function textContent(text: string, style?: TextStyle): Content {
  return style && !isEmptyObject(style) ? { text, runs: [[text.length, style]] } : { text };
}

export function pieceToContent(piece: StoryPiece, table: TextStyleTable): StoryContent {
  const out: StoryContent = { text: piece.text };
  const runs: [number, TextStyle][] = [];
  let start = 0;
  for (let i = 1; i <= piece.styles.length; i++) {
    if (i === piece.styles.length || piece.styles[i] !== piece.styles[start]) {
      runs.push([i - start, table.get(piece.styles[start]!)]);
      start = i;
    }
  }
  // Trailing default-styled text needs no run.
  while (runs.length && isEmptyObject(runs[runs.length - 1]![1])) runs.pop();
  if (runs.length) out.runs = runs;
  const paras: [number, ParaProps][] = [];
  const objects: [number, ObjectData][] = [];
  for (const o of [...piece.attrs.keys()].sort((a, b) => a - b)) {
    const attr = piece.attrs.get(o)!;
    if (piece.text[o] === PARA) {
      if (!isEmptyObject(attr)) paras.push([o, attr as ParaProps]);
    } else if (piece.text[o] === OBJECT) {
      objects.push([o, attr as ObjectData]);
    }
  }
  if (paras.length) out.paras = paras;
  if (objects.length) out.objects = objects;
  return out;
}

export function contentToPiece(content: StoryContent, table: TextStyleTable): StoryPiece {
  const styles = new Array<number>(content.text.length).fill(0);
  let pos = 0;
  for (const [len, style] of content.runs ?? []) {
    const id = table.intern(style);
    for (let i = 0; i < len && pos < styles.length; i++) styles[pos++] = id;
  }
  const attrs = new Map<number, Attr>();
  for (const [o, p] of content.paras ?? []) attrs.set(o, p);
  for (const [o, d] of content.objects ?? []) attrs.set(o, d);
  // Every paragraph mark carries properties, even when they are empty.
  for (let i = content.text.indexOf(PARA); i >= 0; i = content.text.indexOf(PARA, i + 1)) {
    if (!attrs.has(i)) attrs.set(i, {});
  }
  return { text: content.text, styles, attrs };
}

/** Number of characters in the content's own text. */
export function contentLength(content: StoryContent): number {
  return content.text.length;
}

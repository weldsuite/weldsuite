/**
 * Content as a tree of blocks (paragraphs and tables with their cells), the
 * shape the text, HTML and Markdown writers walk.
 *
 * A table object normally sits alone in its paragraph. When it does not (two
 * people typed around it at once), the text before it becomes a paragraph of
 * its own, then the table, then the rest.
 */

import { LINE_BREAK, OBJECT, PARA, TAB } from '../model/chars';
import type { Content, StoryContent } from '../model/content';
import { cellKey, cellStoryId, footnoteStoryId, type CellProps, type ObjectData, type TableData } from '../model/objects';
import type { ListDef, NamedStyle, ParaProps, TextStyle } from '../model/styles';

/** What the writers need: the content, and the lists and named styles its paragraphs refer to. */
export interface WriteSource {
  content: Content;
  lists?: Record<string, ListDef> | Map<string, ListDef>;
  styles?: Record<string, NamedStyle> | Map<string, NamedStyle>;
}

export function lookup<T>(source: Record<string, T> | Map<string, T> | undefined): (id: string) => T | undefined {
  if (!source) return () => undefined;
  return source instanceof Map ? (id) => source.get(id) : (id) => (Object.hasOwn(source, id) ? source[id] : undefined);
}

export type Inline =
  | { type: 'text'; text: string; style: TextStyle }
  | { type: 'break'; style: TextStyle }
  | { type: 'tab'; style: TextStyle }
  | { type: 'object'; data: ObjectData; style: TextStyle };

export interface ParagraphBlock {
  type: 'paragraph';
  props: ParaProps;
  inlines: Inline[];
}

export interface TableCellBlock {
  props: CellProps;
  blocks: Block[];
  /** Covered by a merged cell (its content is not shown). */
  covered: boolean;
}

export interface TableBlock {
  type: 'table';
  id: string;
  data: TableData;
  rows: TableCellBlock[][];
}

export type Block = ParagraphBlock | TableBlock;

/** Footnote texts in the order their references appear, numbered from 1. */
export interface BlockTree {
  blocks: Block[];
  footnotes: { id: string; number: number; blocks: Block[] }[];
}

export function toBlocks(content: Content): BlockTree {
  const footnotes: BlockTree['footnotes'] = [];
  const blocks = storyBlocks(content, content, footnotes);
  return { blocks, footnotes };
}

function storyBlocks(story: StoryContent, all: Content, footnotes: BlockTree['footnotes']): Block[] {
  const { text } = story;
  const styleAt = runLookup(story.runs ?? []);
  const paras = new Map(story.paras ?? []);
  const objects = new Map(story.objects ?? []);
  const blocks: Block[] = [];
  let inlines: Inline[] = [];
  let buf = '';
  let bufStyle: TextStyle | null = null;

  const flushText = () => {
    if (buf) inlines.push({ type: 'text', text: buf, style: bufStyle ?? {} });
    buf = '';
    bufStyle = null;
  };
  const pushParagraph = (props: ParaProps) => {
    flushText();
    blocks.push({ type: 'paragraph', props, inlines });
    inlines = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const style = styleAt(i);
    if (ch === PARA) {
      // The mark of a paragraph that held only a table adds no empty paragraph.
      const onlyTable = inlines.length === 0 && !buf && blocks[blocks.length - 1]?.type === 'table' && text[i - 1] === OBJECT;
      if (!onlyTable) pushParagraph(paras.get(i) ?? {});
      else inlines = [];
      continue;
    }
    if (ch === OBJECT) {
      const data = objects.get(i);
      if (!data) continue;
      if (data.kind === 'table') {
        const table = all.tables?.[data.id];
        if (!table) continue;
        flushText();
        if (inlines.length) pushParagraph(paras.get(text.indexOf(PARA, i)) ?? {});
        blocks.push(tableBlock(data.id, table, all, footnotes));
        continue;
      }
      if (data.kind === 'footnote') {
        const fn = all.stories?.[footnoteStoryId(data.id)];
        footnotes.push({ id: data.id, number: footnotes.length + 1, blocks: fn ? storyBlocks(fn, all, footnotes) : [] });
      }
      flushText();
      inlines.push({ type: 'object', data, style });
      continue;
    }
    if (ch === LINE_BREAK || ch === TAB) {
      flushText();
      inlines.push({ type: ch === TAB ? 'tab' : 'break', style });
      continue;
    }
    if (bufStyle !== null && bufStyle !== style) flushText();
    bufStyle = style;
    buf += ch;
  }
  flushText();
  if (inlines.length) pushParagraph({});
  return blocks;
}

function tableBlock(id: string, data: TableData, all: Content, footnotes: BlockTree['footnotes']): TableBlock {
  const covered = new Set<string>();
  data.rows.forEach((r, ri) =>
    data.cols.forEach((c, ci) => {
      const props = data.cells?.[cellKey(r.id, c.id)];
      const rs = props?.rowSpan ?? 1;
      const cs = props?.colSpan ?? 1;
      if (rs <= 1 && cs <= 1) return;
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          const row = data.rows[ri + dr];
          const col = data.cols[ci + dc];
          if ((dr || dc) && row && col) covered.add(cellKey(row.id, col.id));
        }
      }
    }),
  );
  return {
    type: 'table',
    id,
    data,
    rows: data.rows.map((r) =>
      data.cols.map((c) => {
        const story = all.stories?.[cellStoryId(id, r.id, c.id)];
        return {
          props: data.cells?.[cellKey(r.id, c.id)] ?? {},
          blocks: story ? storyBlocks(story, all, footnotes) : [{ type: 'paragraph', props: {}, inlines: [] }],
          covered: covered.has(cellKey(r.id, c.id)),
        };
      }),
    ),
  };
}

/** Style of the character at an offset, for offsets visited in increasing order. */
function runLookup(runs: [number, TextStyle][]): (offset: number) => TextStyle {
  const empty: TextStyle = {};
  let index = 0;
  let end = runs[0]?.[0] ?? 0;
  return (offset) => {
    while (index < runs.length && offset >= end) {
      index++;
      end += runs[index]?.[0] ?? 0;
    }
    return index < runs.length ? runs[index]![1] : empty;
  };
}

/** The plain text of inlines (objects as their visible text where they have one). */
export function inlineText(inlines: Inline[]): string {
  let out = '';
  for (const i of inlines) {
    if (i.type === 'text') out += i.text;
    else if (i.type === 'tab') out += '\t';
    else if (i.type === 'break') out += '\n';
    else if (i.data.kind === 'chip') out += i.data.label;
  }
  return out;
}

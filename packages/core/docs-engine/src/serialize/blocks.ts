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
  | { type: 'object'; data: ObjectData; style: TextStyle }
  /** Where a bookmark starts or ends (only when asked for: see `BlockOptions.bookmarks`). */
  | { type: 'bookmark'; id: string; edge: 'start' | 'end'; style: TextStyle };

/** A bookmark's range in a story. */
export interface BookmarkRange {
  id: string;
  from: number;
  to: number;
}

export interface BlockOptions {
  /** The id of the story walked (`body` for a document). */
  story?: string;
  /** The bookmarks to mark in a story, by its id; without it, none are. */
  bookmarks?: (story: string) => readonly BookmarkRange[];
}

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

export function toBlocks(content: Content, options: BlockOptions = {}): BlockTree {
  const footnotes: BlockTree['footnotes'] = [];
  const blocks = storyBlocks(content, { all: content, footnotes, bookmarks: options.bookmarks }, options.story ?? '');
  return { blocks, footnotes };
}

interface WalkContext {
  all: Content;
  footnotes: BlockTree['footnotes'];
  bookmarks?: BlockOptions['bookmarks'];
}

function storyBlocks(story: StoryContent, ctx: WalkContext, storyId: string): Block[] {
  return new StoryWalker(story, ctx, storyId).walk();
}

/** Bookmark edges at one offset, in the order they are written: ends, starts, then empty ranges (start and end). */
interface MarksAt {
  ends: string[];
  starts: string[];
  empty: string[];
}

function bookmarkMarks(ranges: readonly BookmarkRange[], length: number): Map<number, MarksAt> {
  const out = new Map<number, MarksAt>();
  const at = (pos: number) => {
    let m = out.get(pos);
    if (!m) out.set(pos, (m = { ends: [], starts: [], empty: [] }));
    return m;
  };
  const last = Math.max(0, length - 1);
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, last));
    const to = Math.max(from, Math.min(r.to, last));
    if (from === to) at(from).empty.push(r.id);
    else {
      at(from).starts.push(r.id);
      at(to).ends.push(r.id);
    }
  }
  return out;
}

/** Walks one story's text once, collecting its paragraphs and tables. */
class StoryWalker {
  private readonly text: string;
  private readonly styleAt: (offset: number) => TextStyle;
  private readonly paras: Map<number, ParaProps>;
  private readonly objects: Map<number, ObjectData>;
  private readonly marks: Map<number, MarksAt>;
  private readonly blocks: Block[] = [];
  private inlines: Inline[] = [];
  /** Plain text not yet turned into an inline, all in `bufStyle`. */
  private buf = '';
  private bufStyle: TextStyle | null = null;

  constructor(
    story: StoryContent,
    private readonly ctx: WalkContext,
    storyId: string,
  ) {
    this.text = story.text;
    this.styleAt = runLookup(story.runs ?? []);
    this.paras = new Map(story.paras ?? []);
    this.objects = new Map(story.objects ?? []);
    this.marks = ctx.bookmarks ? bookmarkMarks(ctx.bookmarks(storyId), story.text.length) : new Map();
  }

  walk(): Block[] {
    const { text } = this;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      const style = this.styleAt(i);
      if (this.marks.size) this.bookmarks(i, style);
      if (ch === PARA) this.paragraphMark(i);
      else if (ch === OBJECT) this.object(i, style);
      else if (ch === LINE_BREAK || ch === TAB) {
        this.flushText();
        this.inlines.push({ type: ch === TAB ? 'tab' : 'break', style });
      } else {
        if (this.bufStyle !== null && this.bufStyle !== style) this.flushText();
        this.bufStyle = style;
        this.buf += ch;
      }
    }
    this.flushText();
    if (this.inlines.length) this.pushParagraph({});
    return this.blocks;
  }

  private bookmarks(i: number, style: TextStyle): void {
    const m = this.marks.get(i);
    if (!m) return;
    this.flushText();
    for (const id of m.ends) this.inlines.push({ type: 'bookmark', id, edge: 'end', style });
    for (const id of m.starts) this.inlines.push({ type: 'bookmark', id, edge: 'start', style });
    for (const id of m.empty) this.inlines.push({ type: 'bookmark', id, edge: 'start', style }, { type: 'bookmark', id, edge: 'end', style });
  }

  private paragraphMark(i: number): void {
    // The mark of a paragraph that held only a table adds no empty paragraph.
    const onlyTable =
      this.inlines.length === 0 && !this.buf && this.blocks[this.blocks.length - 1]?.type === 'table' && this.text[i - 1] === OBJECT;
    if (onlyTable) this.inlines = [];
    else this.pushParagraph(this.paras.get(i) ?? {});
  }

  private object(i: number, style: TextStyle): void {
    const data = this.objects.get(i);
    if (!data) return;
    if (data.kind === 'table') {
      this.table(i, data.id);
      return;
    }
    if (data.kind === 'footnote') {
      const fn = this.ctx.all.stories?.[footnoteStoryId(data.id)];
      this.ctx.footnotes.push({
        id: data.id,
        number: this.ctx.footnotes.length + 1,
        blocks: fn ? storyBlocks(fn, this.ctx, footnoteStoryId(data.id)) : [],
      });
    }
    this.flushText();
    this.inlines.push({ type: 'object', data, style });
  }

  /** A table becomes its own block; text before it in the paragraph becomes a paragraph first. */
  private table(i: number, id: string): void {
    const table = this.ctx.all.tables?.[id];
    if (!table) return;
    this.flushText();
    if (this.inlines.length) this.pushParagraph(this.paras.get(this.text.indexOf(PARA, i)) ?? {});
    this.blocks.push(tableBlock(id, table, this.ctx));
  }

  private flushText(): void {
    if (this.buf) this.inlines.push({ type: 'text', text: this.buf, style: this.bufStyle ?? {} });
    this.buf = '';
    this.bufStyle = null;
  }

  private pushParagraph(props: ParaProps): void {
    this.flushText();
    this.blocks.push({ type: 'paragraph', props, inlines: this.inlines });
    this.inlines = [];
  }
}

function tableBlock(id: string, data: TableData, ctx: WalkContext): TableBlock {
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
        const storyId = cellStoryId(id, r.id, c.id);
        const story = ctx.all.stories?.[storyId];
        return {
          props: data.cells?.[cellKey(r.id, c.id)] ?? {},
          blocks: story ? storyBlocks(story, ctx, storyId) : [{ type: 'paragraph', props: {}, inlines: [] }],
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
    else if (i.type === 'object' && i.data.kind === 'chip') out += i.data.label;
  }
  return out;
}

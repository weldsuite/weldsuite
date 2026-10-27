/**
 * What hangs off an object character, plus the document-level records
 * objects point to: sections, tables, anchors.
 *
 * Some objects own stories: a table owns one story per cell, a footnote its
 * text, a section break the headers and footers of the section it ends.
 * Deleting the object character deletes what it owns, and the inverse of
 * that delete carries it all back.
 */

import type { BorderLine, Patch } from './styles';

/** Page geometry and the header/footer switches of one section. Points. */
export interface SectionProps {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** Distance from the page edge to the header / footer. */
  headerMargin: number;
  footerMargin: number;
  columns?: number;
  /** Gap between columns. */
  columnGap?: number;
  /** The first page has its own header and footer. */
  titlePage?: boolean;
  /** Even pages have their own header and footer. */
  evenAndOdd?: boolean;
  /** Page numbering restarts at this number in this section. */
  pageNumberStart?: number;
  pageNumberFormat?: 'decimal' | 'lowerRoman' | 'upperRoman' | 'lowerAlpha' | 'upperAlpha';
  /** Page colour, `#rrggbb`. */
  background?: string;
}

export const A4: Pick<SectionProps, 'pageWidth' | 'pageHeight'> = { pageWidth: 595.3, pageHeight: 841.9 };
export const LETTER: Pick<SectionProps, 'pageWidth' | 'pageHeight'> = { pageWidth: 612, pageHeight: 792 };

export const DEFAULT_SECTION: SectionProps = {
  ...A4,
  marginTop: 72,
  marginBottom: 72,
  marginLeft: 72,
  marginRight: 72,
  headerMargin: 36,
  footerMargin: 36,
};

export type SectionStart = 'nextPage' | 'continuous' | 'evenPage' | 'oddPage';

export type HeaderKind = 'header' | 'footer';
export type HeaderVariant = 'default' | 'first' | 'even';

export interface ImageObject {
  kind: 'image';
  id: string;
  /** A WeldDrive file id (`file:<id>`), or a URL. */
  src: string;
  /** Displayed size, points. */
  width: number;
  height: number;
  alt?: string;
  /** Fractions of the source cut off each side, 0–1. */
  crop?: { top: number; right: number; bottom: number; left: number };
  /** In the line of text (default), or floating with text wrapped around it. */
  wrap?: 'inline' | 'square' | 'topBottom' | 'behind' | 'front';
  /** Floating images: offset from the paragraph's top-left, points. */
  offsetX?: number;
  offsetY?: number;
  border?: BorderLine;
}

export interface TableObject {
  kind: 'table';
  id: string;
}

export interface BreakObject {
  kind: 'pageBreak' | 'columnBreak';
}

/** Ends a section; `section` is the layout of the section that ends here (Word's model). */
export interface SectionBreakObject {
  kind: 'sectionBreak';
  id: string;
  /** How the next section starts. */
  start: SectionStart;
  section: SectionProps;
}

export interface FootnoteObject {
  kind: 'footnote';
  id: string;
}

export interface RuleObject {
  kind: 'hr';
}

/** Text worked out at layout: page number, page count, date, the page a bookmark is on. */
export interface FieldObject {
  kind: 'field';
  field: 'page' | 'pages' | 'date' | 'title' | 'pageRef';
  /** The bookmark (anchor id) whose page a `pageRef` shows. */
  ref?: string;
  /** Date format for `date`, e.g. `d MMMM yyyy`. */
  format?: string;
}

/** A person, record or date shown as a chip, rendered live from the record. */
export interface ChipObject {
  kind: 'chip';
  /** What it points to: `person`, `date`, or a WeldSuite object type (`customer`, `task`, …). */
  type: string;
  ref: string;
  /** Text shown until (or when) the record cannot be read. */
  label: string;
}

/** An equation, kept as LaTeX source. */
export interface EquationObject {
  kind: 'equation';
  latex: string;
}

export type ObjectData =
  | ImageObject
  | TableObject
  | BreakObject
  | SectionBreakObject
  | FootnoteObject
  | RuleObject
  | FieldObject
  | ChipObject
  | EquationObject;

export type ObjectKind = ObjectData['kind'];

/** Changes to an object; its `kind` and `id` never change. */
export type ObjectPatch = Patch<Omit<ImageObject, 'kind' | 'id'>> &
  Patch<Omit<SectionBreakObject, 'kind' | 'id'>> &
  Patch<Omit<FieldObject, 'kind'>> &
  Patch<Omit<ChipObject, 'kind'>> &
  Patch<Omit<EquationObject, 'kind'>>;

export const IMMUTABLE_OBJECT_KEYS = new Set(['kind', 'id']);

// ---------------------------------------------------------------------------
// Tables

export interface TableRow {
  id: string;
  /** Minimum height, points (rows grow to fit). */
  height?: number;
  /** Repeated at the top of every page the table runs onto. */
  header?: boolean;
  /** Keep the row on one page. */
  cantSplit?: boolean;
}

export interface TableCol {
  id: string;
  /** Points. */
  width: number;
}

export interface CellBorders {
  top?: BorderLine;
  bottom?: BorderLine;
  left?: BorderLine;
  right?: BorderLine;
}

export interface CellProps {
  /** On the top-left cell of a merged block; the cells it covers keep their (hidden) content. */
  colSpan?: number;
  rowSpan?: number;
  background?: string;
  vAlign?: 'top' | 'middle' | 'bottom';
  borders?: CellBorders;
  /** Inner padding, points. */
  padding?: number;
}

export interface TableProps {
  align?: 'left' | 'center' | 'right';
  /** Indent from the left margin, points. */
  indent?: number;
  /** Default border of every cell. */
  border?: BorderLine;
  /** Default cell padding, points. */
  padding?: number;
}

/** A table as stored: rows and columns by id, and cell formatting keyed `rowId:colId`. */
export interface TableData {
  rows: TableRow[];
  cols: TableCol[];
  cells?: Record<string, CellProps>;
  props?: TableProps;
}

export type TableAxis = 'row' | 'col';
export type DimData = TableRow | TableCol;
export type RowPatch = Patch<Omit<TableRow, 'id'>>;
export type ColPatch = Patch<Omit<TableCol, 'id'>>;

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

// ---------------------------------------------------------------------------
// Story ids

export const BODY = 'body';

export function cellStoryId(tableId: string, rowId: string, colId: string): string {
  return `cell:${tableId}:${rowId}:${colId}`;
}

export function footnoteStoryId(footnoteId: string): string {
  return `fn:${footnoteId}`;
}

/** Header/footer story of a section; the last section's id is `final`. */
export function headerStoryId(sectionId: string, kind: HeaderKind, variant: HeaderVariant): string {
  return `${kind === 'header' ? 'hdr' : 'ftr'}:${sectionId}:${variant}`;
}

export const FINAL_SECTION = 'final';

export const HEADER_VARIANTS: readonly HeaderVariant[] = ['default', 'first', 'even'];

export type StoryKind = 'body' | 'cell' | 'footnote' | 'header' | 'footer';

export function storyKind(id: string): StoryKind | null {
  if (id === BODY) return 'body';
  if (id.startsWith('cell:')) return 'cell';
  if (id.startsWith('fn:')) return 'footnote';
  if (id.startsWith('hdr:')) return 'header';
  if (id.startsWith('ftr:')) return 'footer';
  return null;
}

/** The section a header/footer story belongs to, or null for other stories. */
export function headerSection(id: string): { sectionId: string; kind: HeaderKind; variant: HeaderVariant } | null {
  const m = /^(hdr|ftr):(.+):(default|first|even)$/.exec(id);
  if (!m) return null;
  return { sectionId: m[2]!, kind: m[1] === 'hdr' ? 'header' : 'footer', variant: m[3] as HeaderVariant };
}

// ---------------------------------------------------------------------------
// Anchors

/**
 * A range that moves with the text around it: comments, bookmarks. Not a
 * character in the story; inserts and deletes shift it.
 */
export interface Anchor {
  id: string;
  kind: 'comment' | 'bookmark';
  story: string;
  from: number;
  to: number;
}

/**
 * A discussion: a comment thread on a stretch of text (the comment anchor
 * with the same id), or a suggestion's thread (`suggestion` set instead).
 * What is said in it (the first comment, replies, mentions, reactions) is a
 * thread in the document's WeldChat chat whose messages carry this id as
 * `metadata.anchor.id` (ADR CHAT-007); the document keeps who started it,
 * whether it is resolved and what it is about.
 */
export interface DocComment {
  id: string;
  /** Who started it: a suggestion's author, and as a commenter the only one who may move or remove it. */
  author: { id: string; name: string };
  /** Epoch ms. */
  createdAt: number;
  /** The discussion is done. */
  resolved?: boolean;
  /** The suggestion (its id on the text) this thread belongs to. */
  suggestion?: string;
  /** The text commented on, as it was. */
  quote?: string;
}

/** A comment as documents stored it before the text moved to WeldChat: one entry per comment, with its thread's id. */
export function isLegacyComment(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'thread' in v;
}

/**
 * The discussions of a stored document. One from before comments moved to
 * WeldChat holds each comment's text, replies as entries of their own: its
 * comment threads are left out, and a suggestion's thread keeps who
 * suggested it.
 */
export function currentComments(stored: readonly unknown[]): DocComment[] {
  const out: DocComment[] = [];
  for (const raw of stored) {
    if (!isLegacyComment(raw)) {
      out.push(raw as DocComment);
      continue;
    }
    const c = raw as { id?: unknown; thread?: unknown; author?: { id?: unknown; name?: unknown }; createdAt?: unknown; resolved?: unknown; suggestion?: unknown };
    if (typeof c.id !== 'string' || c.thread !== c.id || typeof c.suggestion !== 'string') continue;
    if (typeof c.author?.id !== 'string' || typeof c.author.name !== 'string') continue;
    const kept: DocComment = { id: c.id, author: { id: c.author.id, name: c.author.name }, createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0, suggestion: c.suggestion };
    if (c.resolved === true) kept.resolved = true;
    out.push(kept);
  }
  return out;
}

export interface DocProps {
  /** Layout of the last section (the only one in most documents). */
  section: SectionProps;
  /** Shown without page breaks (Google Docs' pageless). */
  pageless?: boolean;
  /** Default distance between tab stops, points. */
  tabInterval?: number;
}

export type DocPropsPatch = Patch<DocProps>;

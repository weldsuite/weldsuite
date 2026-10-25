/**
 * What layout produces: paragraphs broken into lines, tables into rows, and
 * pages holding them. Positions inside a paragraph are offsets from the
 * paragraph's start, so a paragraph's layout stays valid while text before
 * it moves (only its entry's `start` changes).
 */

import type { ImageObject, ObjectData, SectionProps, TableData } from '../model/objects';
import type { ParaProps, TabStop } from '../model/styles';
import type { FontSpec } from './measure';

/** How a run of text looks once named styles and direct formatting are combined. */
export interface RunStyle {
  font: FontSpec;
  color: string;
  highlight?: string;
  underline?: boolean;
  strike?: boolean;
  /** Shift of the baseline, points (up is positive). */
  baselineShift?: number;
  link?: string;
  suggestion?: { id: string; kind: 'insert' | 'delete' | 'format' };
  spacing?: number;
  /** Drawn in capitals (all caps, small caps). */
  caps?: boolean;
}

export interface RunLayout {
  kind: 'text' | 'tab' | 'object' | 'break' | 'mark';
  /** Offsets from the paragraph start; `end` exclusive. */
  start: number;
  end: number;
  /** From the line's left edge, points. */
  x: number;
  width: number;
  style: RunStyle;
  /** Text as drawn (all caps applied); text runs only. */
  text?: string;
  /** Extra space after each space character (justified lines). */
  wordSpacing?: number;
  object?: ObjectData;
  /** Ascent of an object box above the baseline (its height for images). */
  objectAscent?: number;
  /** Tab leader to draw across the tab's width. */
  leader?: TabStop['leader'];
}

export interface LineLayout {
  /** Offsets from the paragraph start; `end` exclusive (includes trailing spaces and the break or mark). */
  start: number;
  end: number;
  /** Left edge from the paragraph box's left edge (indents and alignment), points. */
  x: number;
  /** Width of the visible content. */
  width: number;
  /** Full height including line spacing. */
  height: number;
  /** Baseline from the line's top. */
  ascent: number;
  runs: RunLayout[];
  /** List marker, on a paragraph's first line. */
  marker?: { text: string; x: number; width: number; style: RunStyle };
  /** The line ends at a page, column or section break. */
  breakAfter?: 'page' | 'column' | 'section';
  /** The section break ending here, when `breakAfter` is 'section'. */
  sectionBreak?: { id: string; start: string; section: SectionProps };
  /** A horizontal rule line. */
  rule?: boolean;
  /** Footnote ids referenced on this line, in order. */
  footnotes?: string[];
}

export interface CellLayout {
  rowIndex: number;
  colIndex: number;
  rowSpan: number;
  colSpan: number;
  story: string;
  /** From the table's left edge, points. */
  x: number;
  width: number;
  /** Height of the content (without padding). */
  contentHeight: number;
  padding: number;
  paragraphs: { entry: ParaEntry; layout: ParagraphLayout; y: number }[];
  background?: string;
  vAlign: 'top' | 'middle' | 'bottom';
}

export interface RowLayout {
  index: number;
  /** Final height (fits the tallest cell, at least the row's minimum). */
  height: number;
  header: boolean;
  cantSplit: boolean;
  /** Cells anchored in this row (covered cells are left out). */
  cells: CellLayout[];
}

export interface TableLayout {
  id: string;
  data: TableData;
  /** From the paragraph box's left edge. */
  x: number;
  width: number;
  colX: number[];
  colWidths: number[];
  rows: RowLayout[];
  /** Number of leading header rows, repeated on every page the table runs onto. */
  headerRows: number;
}

export type BlockLayout = { kind: 'lines'; lines: LineLayout[] } | { kind: 'table'; table: TableLayout; offset: number };

/** A floating image of a paragraph, placed from the paragraph box's left edge and its first line's top. */
export interface FloatLayout {
  /** Offset of its object character from the paragraph start. */
  offset: number;
  image: ImageObject;
  wrap: 'square' | 'topBottom' | 'behind' | 'front';
  /** The side the float sits at (`square` only); text wraps on the other. */
  side?: 'left' | 'right';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParagraphLayout {
  /** Paragraph properties with the named style resolved. */
  props: ParaProps;
  blocks: BlockLayout[];
  /** Floating images, drawn with the paragraph's first lines. */
  floats?: FloatLayout[];
  spaceBefore: number;
  spaceAfter: number;
  /** Width it was laid out at. */
  width: number;
  /** Sum of block heights (without spacing). */
  height: number;
}

/** A paragraph of a story: where it is now and how it lays out. */
export interface ParaEntry {
  /** Position of its first character in the story. */
  start: number;
  /** Position of its paragraph mark. */
  end: number;
  layout: ParagraphLayout | null;
  /** What the cached layout was made for (width, marker, styles version). */
  key: string;
  /** The paragraph's own content, recorded when a story is re-scanned (to reuse layouts). */
  content?: string;
}

/** Something placed on a page: some lines of a paragraph, or some rows of a table. */
export type PlacedItem =
  | {
      kind: 'lines';
      story: string;
      entry: ParaEntry;
      block: number;
      /** Lines [from, to) of the block. */
      from: number;
      to: number;
      /** Page coordinates of the paragraph box's left edge and the first line's top. */
      x: number;
      y: number;
      width: number;
    }
  | {
      kind: 'rows';
      story: string;
      entry: ParaEntry;
      block: number;
      /** Header rows repeated above `from` (empty on the table's first page). */
      repeat: number[];
      from: number;
      to: number;
      x: number;
      y: number;
      width: number;
    };

export interface PageArea {
  items: PlacedItem[];
  /** The story shown here (a header or footer), if any. */
  story?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageLayout {
  index: number;
  /** The number shown on the page (numbering restarts per section). */
  number: number;
  /** Formatted page number (roman numerals and so on). */
  label: string;
  sectionId: string;
  section: SectionProps;
  width: number;
  height: number;
  /** One area per column. */
  columns: PageArea[];
  header?: PageArea;
  footer?: PageArea;
  footnotes?: PageArea;
}

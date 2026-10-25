/**
 * Breaks one paragraph into lines.
 *
 * The paragraph's text is cut into pieces that cannot be broken inside
 * (words with their trailing spaces, tabs, objects), each measured once;
 * lines are then filled greedily. Trailing spaces hang past the right edge,
 * as in every word processor; a word wider than a whole line is broken
 * between characters. A table object splits the paragraph: the text before
 * it, the table, then the rest (always at least the line holding the mark).
 */

import { LINE_BREAK, OBJECT, PARA, TAB } from '../model/chars';
import type { DocModel } from '../model/document';
import type { BreakObject, FieldObject, ImageObject, ObjectData, SectionBreakObject } from '../model/objects';
import { resolveParagraph } from '../model/resolve';
import type { Story } from '../model/story';
import type { ListLevel, ParaProps, TabStop } from '../model/styles';
import { canBreakBefore, isSpaceChar } from './breaks';
import { FloatBands, isFloating, placeFloats, type LineBand } from './floats';
import type { TextMeasurer } from './measure';
import { displayText, type RunStyles } from './run-style';
import type { BlockLayout, FloatLayout, LineLayout, ParagraphLayout, RunLayout, RunStyle, TableLayout } from './types';

export interface ParagraphContext {
  doc: DocModel;
  measurer: TextMeasurer;
  styles: RunStyles;
  /** Default distance between tab stops. */
  tabInterval: number;
  footnoteNumber(id: string): number;
  layoutTable(tableId: string, width: number): TableLayout | null;
}

export interface Marker {
  text: string;
  level: ListLevel;
}

const EPS = 0.01;
const RULE_HEIGHT = 12;
const MIN_SIZE = 1;

type Item =
  | {
      kind: 'text';
      start: number;
      end: number;
      text: string;
      style: RunStyle;
      width: number;
      /** Width of the trailing spaces (they hang at a line end). */
      trail: number;
      trailSpaces: number;
      /** Cannot break before this piece. */
      glue: boolean;
    }
  | { kind: 'tab'; start: number; end: number; style: RunStyle; width: number; glue: false; leader?: TabStop['leader'] }
  | { kind: 'object'; start: number; end: number; style: RunStyle; object: ObjectData; width: number; ascent: number; descent: number; glue: boolean; text?: string }
  | { kind: 'break' | 'mark'; start: number; end: number; style: RunStyle; width: 0; glue: true };

type TextItem = Extract<Item, { kind: 'text' }>;
type ObjectItem = Extract<Item, { kind: 'object' }>;
type LineEnd = 'wrap' | 'last' | 'forced';

export function layoutParagraph(ctx: ParagraphContext, story: Story, start: number, end: number, width: number, marker: Marker | null): ParagraphLayout {
  const markStyleId = story.styleAt(end);
  const rawProps = (story.attrAt(end) as ParaProps | undefined) ?? {};
  const props = resolveParagraph(ctx.doc, rawProps);
  const items = buildItems(ctx, story, start, end, props);
  const floats = placeFloats(floatingImages(items), width);
  const breaker = new LineBreaker(ctx, props, width, marker, markStyleId, floats);
  const blocks = breaker.run(items);
  const height = blocksHeight(blocks);
  const layout: ParagraphLayout = {
    props,
    blocks,
    spaceBefore: props.spaceBefore ?? 0,
    // A paragraph shorter than its floats leaves room for them.
    spaceAfter: (props.spaceAfter ?? 0) + Math.max(0, breaker.floatBottom - height),
    width,
    height,
  };
  if (floats.length) layout.floats = floats;
  return layout;
}

function floatingImages(items: Item[]): { offset: number; image: ImageObject }[] {
  const out: { offset: number; image: ImageObject }[] = [];
  for (const it of items) if (it.kind === 'object' && isFloating(it.object)) out.push({ offset: it.start, image: it.object as ImageObject });
  return out;
}

function blocksHeight(blocks: BlockLayout[]): number {
  let height = 0;
  for (const b of blocks) {
    if (b.kind === 'lines') for (const l of b.lines) height += l.height;
    else for (const r of b.table.rows) height += r.height;
  }
  return height;
}

// ---------------------------------------------------------------- filling lines

/**
 * Fills lines greedily from a paragraph's items. Its state is the line being
 * filled (its items and width so far) and the blocks finished so far: runs
 * of lines, split by the tables the paragraph holds.
 */
class LineBreaker {
  private readonly blocks: BlockLayout[] = [];
  private lines: LineLayout[] = [];
  private lineItems: Item[] = [];
  /** Width of the line being filled. */
  private x = 0;
  private firstLine = true;
  /**
   * Set when a piece with the pieces glued to it is wider than a line: the
   * glue no longer holds, so the next pieces may wrap one by one.
   */
  private ignoreGlue = false;
  private readonly left: number;
  private readonly right: number;
  /** Left edge of the first line (first-line indent, or past the list marker). */
  private readonly firstX: number;
  private readonly marker: LineLayout['marker'];
  private readonly bands: FloatBands | null;
  /** Top of the line being filled, from the first line's top. */
  private lineTop = 0;
  /** Where the line being filled goes, around the floats. */
  private band: LineBand;

  constructor(
    private readonly ctx: ParagraphContext,
    private readonly props: ParaProps,
    private readonly width: number,
    marker: Marker | null,
    markStyleId: number,
    floats: FloatLayout[],
  ) {
    this.bands = floats.length ? new FloatBands(floats, width) : null;
    this.band = this.bandAt(0);
    const listLevel = marker?.level;
    this.left = listLevel ? listLevel.indent : (props.indentLeft ?? 0);
    this.right = props.indentRight ?? 0;
    if (!marker) {
      this.firstX = this.left + (props.indentFirst ?? 0);
      return;
    }
    const style = ctx.styles.fromStyle(props, { ...ctx.doc.textStyles.get(markStyleId), ...listLevel?.style });
    const markerWidth = ctx.measurer.measure(marker.text, style.font);
    const markerX = marker.level.indent - marker.level.hanging;
    this.firstX = Math.max(this.left, markerX + markerWidth + 4);
    this.marker = { text: marker.text, x: markerX, width: markerWidth, style };
  }

  run(items: Item[]): BlockLayout[] {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (this.placeLineEnding(it)) continue;
      if (it.kind === 'tab') it.width = tabWidth(this.ctx, items, i, this.x, this.props, this.lineLeft(), this.left, this.avail());
      this.wrapBefore(items, i);
      if (this.breakLongWord(items, i)) continue;
      this.lineItems.push(it);
      this.x += it.width;
    }
    if (this.lineItems.length) this.flush('last');
    this.closeBlock();
    return this.blocks;
  }

  /** Bottom of the floats text keeps clear of, from the first line's top. */
  get floatBottom(): number {
    return this.bands?.bottom ?? 0;
  }

  private bandAt(top: number): LineBand {
    return this.bands ? this.bands.at(top) : { pad: 0, left: 0, right: this.width };
  }

  private lineLeft(): number {
    return Math.max(this.firstLine ? this.firstX : this.left, this.band.left);
  }

  /** Width available to the line being filled. */
  private avail(): number {
    return Math.max(MIN_SIZE, Math.min(this.width - this.right, this.band.right) - this.lineLeft());
  }

  private flush(reason: LineEnd, extra: Partial<LineLayout> = {}): void {
    const line = buildLine(this.ctx, this.lineItems, reason, this.props, this.lineLeft(), this.avail(), this.firstLine ? this.marker : undefined, extra);
    // Moved down past a float: the space above is part of the line.
    line.height += this.band.pad;
    line.ascent += this.band.pad;
    this.lines.push(line);
    this.lineItems = [];
    this.x = 0;
    this.firstLine = false;
    this.advance(line.height);
  }

  private advance(height: number): void {
    this.lineTop += height;
    if (this.bands) this.band = this.bandAt(this.lineTop);
  }

  private closeBlock(): void {
    if (this.lines.length) this.blocks.push({ kind: 'lines', lines: this.lines });
    this.lines = [];
  }

  /** Paragraph marks, line breaks, page and section breaks, rules and tables end the line themselves; true when `it` was one. */
  private placeLineEnding(it: Item): boolean {
    switch (it.kind) {
      case 'mark':
        this.lineItems.push(it);
        this.flush('last');
        return true;
      case 'break':
        this.lineItems.push(it);
        this.flush('forced');
        return true;
      case 'object':
        return this.placeBlockObject(it);
      default:
        return false;
    }
  }

  private placeBlockObject(it: ObjectItem): boolean {
    const obj = it.object;
    switch (obj.kind) {
      case 'table':
        this.placeTable(obj.id, it.start);
        return true;
      case 'pageBreak':
      case 'columnBreak':
      case 'sectionBreak':
        this.lineItems.push(it);
        this.flush('forced', breakAfter(obj));
        return true;
      case 'hr':
        if (this.lineItems.length) this.flush('forced');
        this.lineItems.push(it);
        this.flush('forced', { rule: true });
        return true;
      default:
        return false;
    }
  }

  private placeTable(tableId: string, offset: number): void {
    if (this.lineItems.length) this.flush('forced');
    this.closeBlock();
    const table = this.ctx.layoutTable(tableId, Math.max(MIN_SIZE, this.width - this.left - this.right));
    if (table) {
      table.x += this.left;
      this.blocks.push({ kind: 'table', table, offset });
      this.advance(table.rows.reduce((n, r) => n + r.height, 0));
    }
  }

  /** Starts a new line when the piece at `i`, with any glued to it, does not fit on this one. */
  private wrapBefore(items: Item[], i: number): void {
    if (items[i]!.glue && !this.ignoreGlue) return;
    this.ignoreGlue = false;
    const chunk = chunkWidth(items, i);
    if (this.lineItems.length && this.x + chunk > this.avail() + EPS) this.flush('wrap');
    if (!this.lineItems.length && chunk > this.avail() + EPS) this.ignoreGlue = true;
  }

  /** A word wider than the line: breaks it between characters. True when it did. */
  private breakLongWord(items: Item[], i: number): boolean {
    const it = items[i]!;
    if (!this.isOverlong(it)) return false;
    const fit = fitChars(this.ctx.measurer, it.text, it.style, this.avail());
    if (fit >= it.text.length) return false;
    const head = splitText(this.ctx, it, 0, fit);
    const tail = splitText(this.ctx, it, fit, it.text.length);
    this.lineItems.push(head);
    this.flush('wrap');
    items.splice(i + 1, 0, { ...tail, glue: true });
    this.ignoreGlue = true;
    return true;
  }

  /** A word (not a single character) starting a line it is too wide for. */
  private isOverlong(it: Item): it is TextItem {
    return it.kind === 'text' && !this.lineItems.length && it.width - it.trail > this.avail() + EPS && it.text.trim().length > 1;
  }
}

/** What a line ending in a page, column or section break records about it. */
function breakAfter(obj: BreakObject | SectionBreakObject): Partial<LineLayout> {
  if (obj.kind === 'sectionBreak') return { breakAfter: 'section', sectionBreak: { id: obj.id, start: obj.start, section: obj.section } };
  return { breakAfter: obj.kind === 'pageBreak' ? 'page' : 'column' };
}

/** Width of trailing spaces that hang past the line end. */
function trailOf(it: Item): number {
  return it.kind === 'text' ? it.trail : 0;
}

/** Width of the piece at `i` and any glued after it (the last one's trailing spaces hang). */
function chunkWidth(items: Item[], i: number): number {
  const it = items[i]!;
  let chunk = it.width - trailOf(it);
  let acc = it.width;
  for (let j = i + 1; j < items.length; j++) {
    const next = items[j]!;
    if (!next.glue || next.kind === 'mark' || next.kind === 'break') break;
    chunk = acc + next.width - trailOf(next);
    acc += next.width;
  }
  return chunk;
}

// ---------------------------------------------------------------- items

function buildItems(ctx: ParagraphContext, story: Story, start: number, end: number, props: ParaProps): Item[] {
  const text = story.text(start, end + 1);
  const items: Item[] = [];
  story.forEachRun(start, end + 1, (runStart, runEnd, styleId) => {
    const style = ctx.styles.get(props, styleId);
    splitRun({ ctx, story, text, paraStart: start, style, items }, runStart - start, runEnd - start);
  });
  glueAcrossRuns(text, items);
  return items;
}

interface RunSplit {
  ctx: ParagraphContext;
  story: Story;
  /** The paragraph's text. */
  text: string;
  paraStart: number;
  style: RunStyle;
  items: Item[];
}

/** Cuts the run at paragraph offsets [from, to) into items: unbreakable text pieces and control characters. */
function splitRun(run: RunSplit, from: number, to: number): void {
  const { ctx, text, style, items } = run;
  let pieceStart = -1;
  for (let p = from; p < to; p++) {
    const ch = text[p]!;
    if (ch === PARA || ch === LINE_BREAK || ch === TAB || ch === OBJECT) {
      if (pieceStart >= 0) items.push(textItem(ctx, text, pieceStart, p, style));
      pieceStart = -1;
      const item = controlItem(run, ch, p);
      if (item) items.push(item);
    } else if (pieceStart < 0) {
      pieceStart = p;
    } else if (canBreakBefore(text, p)) {
      items.push(textItem(ctx, text, pieceStart, p, style));
      pieceStart = p;
    }
  }
  if (pieceStart >= 0) items.push(textItem(ctx, text, pieceStart, to, style));
}

/** The item for a paragraph mark, line break, tab or object at offset `p` (null for an object without data). */
function controlItem(run: RunSplit, ch: string, p: number): Item | null {
  const style = run.style;
  switch (ch) {
    case PARA:
      return { kind: 'mark', start: p, end: p + 1, style, width: 0, glue: true };
    case LINE_BREAK:
      return { kind: 'break', start: p, end: p + 1, style, width: 0, glue: true };
    case TAB:
      return { kind: 'tab', start: p, end: p + 1, style, width: 0, glue: false };
    default: {
      const obj = run.story.attrAt(run.paraStart + p) as ObjectData | undefined;
      return obj ? objectItem(run.ctx, obj, p, style) : null;
    }
  }
}

/** A text piece is glued to the item before it unless a break is allowed between them. */
function glueAcrossRuns(text: string, items: Item[]): void {
  for (let i = 1; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'text') it.glue = !breaksAfter(items[i - 1]!) && !canBreakBefore(text, it.start);
  }
}

/** A line may always break after a tab or an object (footnote references excepted). */
function breaksAfter(it: Item): boolean {
  return it.kind === 'tab' || (it.kind === 'object' && !isInlineGlued(it.object));
}

function textItem(ctx: ParagraphContext, text: string, from: number, to: number, style: RunStyle): TextItem {
  const raw = text.slice(from, to);
  let trailSpaces = 0;
  while (trailSpaces < raw.length && isSpaceChar(raw[raw.length - 1 - trailSpaces]!)) trailSpaces++;
  const shown = displayText(raw, style);
  const spacing = style.spacing ?? 0;
  const width = ctx.measurer.measure(shown, style.font) + spacing * raw.length;
  const trail = trailSpaces ? ctx.measurer.measure(shown.slice(shown.length - trailSpaces), style.font) + spacing * trailSpaces : 0;
  return { kind: 'text', start: from, end: to, text: shown, style, width, trail, trailSpaces, glue: false };
}

function splitText(ctx: ParagraphContext, it: TextItem, from: number, to: number): TextItem {
  const piece = it.text.slice(from, to);
  const tail = to === it.text.length ? it.trailSpaces : 0;
  const spacing = it.style.spacing ?? 0;
  return {
    ...it,
    start: it.start + from,
    end: it.start + to,
    text: piece,
    width: ctx.measurer.measure(piece, it.style.font) + spacing * piece.length,
    trail: tail ? it.trail : 0,
    trailSpaces: tail,
  };
}

/** Footnote references stick to the word before them. */
function isInlineGlued(obj: ObjectData): boolean {
  return obj.kind === 'footnote';
}

/** Stand-in text a field is measured with; drawing fills in the real value. */
function fieldPlaceholder(field: FieldObject['field']): string {
  if (field === 'date') return '00/00/0000';
  if (field === 'title') return 'Title';
  return '00';
}

function objectItem(ctx: ParagraphContext, obj: ObjectData, p: number, style: RunStyle): Item {
  const m = ctx.measurer.metrics(style.font);
  const base = { kind: 'object' as const, start: p, end: p + 1, style, object: obj, glue: isInlineGlued(obj) };
  switch (obj.kind) {
    case 'image':
      // A floating image is placed apart; its anchor takes no room in the line.
      return isFloating(obj) ? { ...base, width: 0, ascent: 0, descent: 0 } : { ...base, width: obj.width, ascent: obj.height, descent: 0 };
    case 'footnote': {
      const text = String(ctx.footnoteNumber(obj.id));
      const font = { ...style.font, size: style.font.size * 0.65 };
      return { ...base, style: { ...style, font, baselineShift: style.font.size * 0.33 }, text, width: ctx.measurer.measure(text, font), ascent: m.ascent, descent: m.descent };
    }
    case 'field': {
      const text = fieldPlaceholder(obj.field);
      return { ...base, text, width: ctx.measurer.measure(text, style.font), ascent: m.ascent, descent: m.descent };
    }
    case 'chip':
      return { ...base, text: obj.label, width: ctx.measurer.measure(obj.label, style.font) + 12, ascent: m.ascent + 2, descent: m.descent + 2 };
    case 'equation': {
      const font = { ...style.font, italic: true, family: 'Times New Roman' };
      return { ...base, text: obj.latex, width: ctx.measurer.measure(obj.latex, font), ascent: m.ascent, descent: m.descent };
    }
    default:
      return { ...base, width: 0, ascent: m.ascent, descent: m.descent };
  }
}

/** Largest number of leading characters of `text` that fit in `width` (at least one character). */
function fitChars(measurer: TextMeasurer, text: string, style: RunStyle, width: number): number {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measurer.measure(text.slice(0, mid), style.font) <= width) lo = mid;
    else hi = mid - 1;
  }
  // Keep surrogate pairs whole.
  const code = text.charCodeAt(lo - 1);
  if (code >= 0xd800 && code <= 0xdbff && lo < text.length) lo++;
  return lo;
}

// ---------------------------------------------------------------- tabs

/** Width of the tab at `items[i]` when the line so far is `x` wide. */
function tabWidth(ctx: ParagraphContext, items: Item[], i: number, x: number, props: ParaProps, lineLeft: number, left: number, avail: number): number {
  // Stops are measured from the paragraph's left indent; x is from the line's left.
  const pos = lineLeft - left + x;
  const stops = (props.tabs ?? []).filter((t) => t.pos > pos + EPS).sort((a, b) => a.pos - b.pos);
  const stop: TabStop = stops[0] ?? { pos: (Math.floor(pos / ctx.tabInterval + EPS) + 1) * ctx.tabInterval, align: 'left' };
  const item = items[i]!;
  if (item.kind === 'tab' && stop.leader && stop.leader !== 'none') item.leader = stop.leader;
  let w = stop.pos - pos;
  if (stop.align !== 'left') w -= alignShift(ctx, items, i, stop.align);
  if (x + w > avail) w = Math.max(0, avail - x);
  return Math.max(0, w);
}

/** How far text after a right, center or decimal tab sits back from the stop. */
function alignShift(ctx: ParagraphContext, items: Item[], i: number, align: TabStop['align']): number {
  // Width of what follows up to the next tab or line end.
  let seg = 0;
  let beforeDecimal = 0;
  for (let j = i + 1; j < items.length; j++) {
    const next = items[j]!;
    if (next.kind === 'tab' || next.kind === 'break' || next.kind === 'mark') break;
    if (align === 'decimal' && next.kind === 'text' && beforeDecimal === 0) beforeDecimal = decimalOffset(ctx, next, seg);
    seg += next.width - trailOf(next);
  }
  if (align === 'right') return seg;
  if (align === 'center') return seg / 2;
  return beforeDecimal || seg;
}

/** Offset of the first decimal separator in a piece that starts `seg` after the tab, or 0 when it has none. */
function decimalOffset(ctx: ParagraphContext, it: TextItem, seg: number): number {
  const dot = it.text.search(/[.,]/);
  return dot >= 0 ? seg + ctx.measurer.measure(it.text.slice(0, dot), it.style.font) : 0;
}

// ---------------------------------------------------------------- lines

/** The tallest ascent and descent on a line. */
class LineExtent {
  ascent = 0;
  descent = 0;

  constructor(private readonly measurer: TextMeasurer) {}

  addStyle(style: RunStyle): void {
    const m = this.measurer.metrics(style.font);
    const shift = style.baselineShift ?? 0;
    this.addBox(m.ascent + Math.max(0, shift), m.descent - Math.min(0, shift));
  }

  addBox(ascent: number, descent: number): void {
    this.ascent = Math.max(this.ascent, ascent);
    this.descent = Math.max(this.descent, descent);
  }

  addItem(it: Item): void {
    // Images stand on the baseline at their own height; everything else takes its font's.
    if (it.kind === 'object' && it.object.kind === 'image') this.addBox(it.ascent, it.descent);
    else this.addStyle(it.style);
  }
}

function buildLine(
  ctx: ParagraphContext,
  items: Item[],
  reason: LineEnd,
  props: ParaProps,
  lineLeft: number,
  avail: number,
  marker: LineLayout['marker'],
  extra: Partial<LineLayout>,
): LineLayout {
  // Visible width: without the hanging trailing spaces of the last text piece.
  let width = 0;
  for (const it of items) width += it.width;
  const trailing = trailingText(items);
  const visible = width - (trailing?.trail ?? 0);

  // Justified lines stretch their spaces (not on the last line or before a forced break).
  const align = props.align ?? 'left';
  const wordSpacing = align === 'justify' && reason === 'wrap' ? justifySpacing(items, trailing, avail - visible) : 0;

  const extent = new LineExtent(ctx.measurer);
  const runs = buildRuns(items, wordSpacing, extent);
  if (marker) extent.addStyle(marker.style);
  if (extent.ascent === 0 && extent.descent === 0 && items[0]) extent.addStyle(items[0].style);
  const { height, ascent } = lineHeight(props, extent, !!extra.rule);

  const footnotes = items.filter((it): it is ObjectItem => it.kind === 'object' && it.object.kind === 'footnote').map((it) => (it.object as { id: string }).id);
  const line: LineLayout = {
    start: items[0]?.start ?? 0,
    end: items[items.length - 1]?.end ?? 0,
    x: lineLeft + alignOffset(align, avail - visible),
    width: visible,
    height,
    ascent,
    runs,
    ...extra,
  };
  if (marker) line.marker = marker;
  if (footnotes.length) line.footnotes = footnotes;
  return line;
}

/** The last text piece, when nothing but the line's end follows it (its trailing spaces then hang). */
function trailingText(items: Item[]): TextItem | null {
  let lastText = -1;
  for (let i = 0; i < items.length; i++) if (items[i]!.kind === 'text') lastText = i;
  if (lastText < 0) return null;
  const endsLine = items.slice(lastText + 1).every((it) => it.kind === 'mark' || it.kind === 'break' || (it.kind === 'object' && it.width === 0));
  return endsLine ? (items[lastText] as TextItem) : null;
}

/** Extra width per space that stretches a justified line by `free`. */
function justifySpacing(items: Item[], trailing: TextItem | null, free: number): number {
  let spaces = 0;
  for (const it of items) if (it.kind === 'text') spaces += countSpaces(it.text);
  if (trailing) spaces -= trailing.trailSpaces;
  return spaces > 0 ? Math.max(0, free / spaces) : 0;
}

/** Runs: neighbouring text pieces of one style become one run. */
function buildRuns(items: Item[], wordSpacing: number, extent: LineExtent): RunLayout[] {
  const runs: RunLayout[] = [];
  let rx = 0;
  for (const it of items) {
    if (it.kind === 'text') rx += addTextRun(runs, it, rx, wordSpacing);
    else {
      runs.push(otherRun(it, rx));
      rx += it.width;
    }
    extent.addItem(it);
  }
  return runs;
}

/** Appends a text piece at `rx`, merged into the previous run when it continues it; returns its width. */
function addTextRun(runs: RunLayout[], it: TextItem, rx: number, wordSpacing: number): number {
  const advance = it.width + wordSpacing * countSpaces(it.text);
  const last = runs[runs.length - 1];
  if (last && last.kind === 'text' && last.style === it.style && last.end === it.start) {
    last.text += it.text;
    last.end = it.end;
    last.width += advance;
  } else {
    const run: RunLayout = { kind: 'text', start: it.start, end: it.end, x: rx, width: advance, style: it.style, text: it.text };
    if (wordSpacing) run.wordSpacing = wordSpacing;
    runs.push(run);
  }
  return advance;
}

function otherRun(it: Exclude<Item, TextItem>, rx: number): RunLayout {
  if (it.kind === 'object') {
    const run: RunLayout = { kind: 'object', start: it.start, end: it.end, x: rx, width: it.width, style: it.style, object: it.object, objectAscent: it.ascent };
    if (it.text !== undefined) run.text = it.text;
    return run;
  }
  const run: RunLayout = { kind: it.kind, start: it.start, end: it.end, x: rx, width: it.width, style: it.style };
  if (it.kind === 'tab' && it.leader) run.leader = it.leader;
  return run;
}

/** Line height and baseline: exact or a multiple of the natural height, the extra split above and below; a rule line is centred. */
function lineHeight(props: ParaProps, extent: LineExtent, rule: boolean): { height: number; ascent: number } {
  const natural = extent.ascent + extent.descent;
  const height = props.lineHeightExact || natural * (props.lineHeight ?? 1);
  if (rule) {
    const ruled = Math.max(height, RULE_HEIGHT);
    return { height: ruled, ascent: ruled / 2 };
  }
  return { height, ascent: extent.ascent + (height - natural) / 2 };
}

/** Where a line's content starts within the space `free` it leaves over. */
function alignOffset(align: NonNullable<ParaProps['align']>, free: number): number {
  if (align === 'center') return Math.max(0, free / 2);
  if (align === 'right') return Math.max(0, free);
  return 0;
}

function countSpaces(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) n++;
  return n;
}

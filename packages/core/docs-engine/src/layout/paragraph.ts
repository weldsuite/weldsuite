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
import type { ObjectData } from '../model/objects';
import { resolveParagraph } from '../model/resolve';
import type { Story } from '../model/story';
import type { ListLevel, ParaProps, TabStop } from '../model/styles';
import { canBreakBefore, isSpaceChar } from './breaks';
import type { TextMeasurer } from './measure';
import { displayText, type RunStyles } from './run-style';
import type { BlockLayout, LineLayout, ParagraphLayout, RunLayout, RunStyle, TableLayout } from './types';

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

export function layoutParagraph(ctx: ParagraphContext, story: Story, start: number, end: number, width: number, marker: Marker | null): ParagraphLayout {
  const markStyleId = story.styleAt(end);
  const rawProps = (story.attrAt(end) as ParaProps | undefined) ?? {};
  const props = resolveParagraph(ctx.doc, rawProps);
  const items = buildItems(ctx, story, start, end, props);

  const blocks: BlockLayout[] = [];
  let lines: LineLayout[] = [];
  let lineItems: Item[] = [];
  let x = 0;
  let firstLine = true;
  let ignoreGlue = false;

  const listLevel = marker?.level;
  const left = listLevel ? listLevel.indent : (props.indentLeft ?? 0);
  const right = props.indentRight ?? 0;
  const markerStyle = marker ? ctx.styles.fromStyle(props, { ...ctx.doc.textStyles.get(markStyleId), ...listLevel?.style }) : null;
  const markerWidth = marker && markerStyle ? ctx.measurer.measure(marker.text, markerStyle.font) : 0;
  const markerX = listLevel ? listLevel.indent - listLevel.hanging : 0;
  const firstX = marker ? Math.max(left, markerX + markerWidth + 4) : left + (props.indentFirst ?? 0);

  const lineLeft = () => (firstLine ? firstX : left);
  const avail = () => Math.max(MIN_SIZE, width - right - lineLeft());

  const flush = (reason: 'wrap' | 'last' | 'forced', extra: Partial<LineLayout> = {}) => {
    lines.push(buildLine(ctx, lineItems, reason, props, lineLeft(), avail(), firstLine && marker && markerStyle ? { text: marker.text, x: markerX, width: markerWidth, style: markerStyle } : undefined, extra));
    lineItems = [];
    x = 0;
    firstLine = false;
  };
  const closeBlock = () => {
    if (lines.length) blocks.push({ kind: 'lines', lines });
    lines = [];
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'object' && it.object.kind === 'table') {
      if (lineItems.length) flush('forced');
      closeBlock();
      const table = ctx.layoutTable(it.object.id, Math.max(MIN_SIZE, width - left - right));
      if (table) {
        table.x += left;
        blocks.push({ kind: 'table', table, offset: it.start });
      }
      continue;
    }
    if (it.kind === 'mark') {
      lineItems.push(it);
      flush('last');
      continue;
    }
    if (it.kind === 'break') {
      lineItems.push(it);
      flush('forced');
      continue;
    }
    if (it.kind === 'object') {
      const k = it.object.kind;
      if (k === 'pageBreak' || k === 'columnBreak' || k === 'sectionBreak') {
        lineItems.push(it);
        flush('forced', {
          breakAfter: k === 'pageBreak' ? 'page' : k === 'columnBreak' ? 'column' : 'section',
          ...(it.object.kind === 'sectionBreak' ? { sectionBreak: { id: it.object.id, start: it.object.start, section: it.object.section } } : {}),
        });
        continue;
      }
      if (k === 'hr') {
        if (lineItems.length) flush('forced');
        lineItems.push(it);
        flush('forced', { rule: true });
        continue;
      }
    }
    if (it.kind === 'tab') it.width = tabWidth(ctx, items, i, x, props, lineLeft(), left, avail());

    // Width of this piece and any glued to it (the last one's trailing spaces hang).
    let chunk = it.width - (it.kind === 'text' ? it.trail : 0);
    if (!it.glue || ignoreGlue) {
      ignoreGlue = false;
      let acc = it.width;
      for (let j = i + 1; j < items.length; j++) {
        const next = items[j]!;
        if (!next.glue || next.kind === 'mark' || next.kind === 'break') break;
        chunk = acc + next.width - (next.kind === 'text' ? next.trail : 0);
        acc += next.width;
      }
      if (lineItems.length && x + chunk > avail() + EPS) flush('wrap');
      if (!lineItems.length && chunk > avail() + EPS) ignoreGlue = true;
    } else if (ignoreGlue && lineItems.length && x + chunk > avail() + EPS) {
      flush('wrap');
    }

    if (it.kind === 'text' && !lineItems.length && it.width - it.trail > avail() + EPS && it.text.trim().length > 1) {
      // A word wider than the line: break it between characters.
      const fit = fitChars(ctx.measurer, it.text, it.style, avail());
      if (fit < it.text.length) {
        const head = splitText(ctx, it, 0, fit);
        const tail = splitText(ctx, it, fit, it.text.length);
        lineItems.push(head);
        flush('wrap');
        items.splice(i + 1, 0, { ...tail, glue: true });
        ignoreGlue = true;
        continue;
      }
    }
    lineItems.push(it);
    x += it.width;
  }
  if (lineItems.length) flush('last');
  closeBlock();

  let height = 0;
  for (const b of blocks) {
    if (b.kind === 'lines') for (const l of b.lines) height += l.height;
    else for (const r of b.table.rows) height += r.height;
  }
  return {
    props,
    blocks,
    spaceBefore: props.spaceBefore ?? 0,
    spaceAfter: props.spaceAfter ?? 0,
    width,
    height,
  };
}

// ---------------------------------------------------------------- items

function buildItems(ctx: ParagraphContext, story: Story, start: number, end: number, props: ParaProps): Item[] {
  const text = story.text(start, end + 1);
  const items: Item[] = [];
  story.forEachRun(start, end + 1, (runStart, runEnd, styleId) => {
    const style = ctx.styles.get(props, styleId);
    let pieceStart = -1;
    const flushPiece = (to: number) => {
      if (pieceStart < 0) return;
      items.push(textItem(ctx, text, pieceStart, to, style));
      pieceStart = -1;
    };
    for (let p = runStart - start; p < runEnd - start; p++) {
      const ch = text[p]!;
      if (ch === PARA || ch === LINE_BREAK || ch === TAB || ch === OBJECT) {
        flushPiece(p);
        if (ch === PARA) items.push({ kind: 'mark', start: p, end: p + 1, style, width: 0, glue: true });
        else if (ch === LINE_BREAK) items.push({ kind: 'break', start: p, end: p + 1, style, width: 0, glue: true });
        else if (ch === TAB) items.push({ kind: 'tab', start: p, end: p + 1, style, width: 0, glue: false });
        else {
          const obj = story.attrAt(start + p) as ObjectData | undefined;
          if (obj) items.push(objectItem(ctx, obj, p, style));
        }
        continue;
      }
      if (pieceStart >= 0 && canBreakBefore(text, p)) flushPiece(p);
      if (pieceStart < 0) pieceStart = p;
    }
    flushPiece(runEnd - start);
  });
  // A piece right after a run boundary is glued unless a break is allowed there.
  for (let i = 1; i < items.length; i++) {
    const it = items[i]!;
    const prev = items[i - 1]!;
    if (it.kind === 'text') it.glue = !(prev.kind === 'tab' || (prev.kind === 'object' && !isInlineGlued(prev.object)) || canBreakBefore(text, it.start));
  }
  return items;
}

function textItem(ctx: ParagraphContext, text: string, from: number, to: number, style: RunStyle): Extract<Item, { kind: 'text' }> {
  const raw = text.slice(from, to);
  let trailSpaces = 0;
  while (trailSpaces < raw.length && isSpaceChar(raw[raw.length - 1 - trailSpaces]!)) trailSpaces++;
  const shown = displayText(raw, style);
  const spacing = style.spacing ?? 0;
  const width = ctx.measurer.measure(shown, style.font) + spacing * raw.length;
  const trail = trailSpaces ? ctx.measurer.measure(shown.slice(shown.length - trailSpaces), style.font) + spacing * trailSpaces : 0;
  return { kind: 'text', start: from, end: to, text: shown, style, width, trail, trailSpaces, glue: false };
}

function splitText(ctx: ParagraphContext, it: Extract<Item, { kind: 'text' }>, from: number, to: number): Extract<Item, { kind: 'text' }> {
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

function objectItem(ctx: ParagraphContext, obj: ObjectData, p: number, style: RunStyle): Item {
  const m = ctx.measurer.metrics(style.font);
  const base = { kind: 'object' as const, start: p, end: p + 1, style, object: obj, glue: isInlineGlued(obj) };
  switch (obj.kind) {
    case 'image':
      return { ...base, width: obj.width, ascent: obj.height, descent: 0 };
    case 'footnote': {
      const text = String(ctx.footnoteNumber(obj.id));
      const font = { ...style.font, size: style.font.size * 0.65 };
      return { ...base, style: { ...style, font, baselineShift: style.font.size * 0.33 }, text, width: ctx.measurer.measure(text, font), ascent: m.ascent, descent: m.descent };
    }
    case 'field': {
      const text = obj.field === 'date' ? '00/00/0000' : obj.field === 'title' ? 'Title' : '00';
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

/** Width of the tab at `items[i]` when the line so far is `x` wide. */
function tabWidth(ctx: ParagraphContext, items: Item[], i: number, x: number, props: ParaProps, lineLeft: number, left: number, avail: number): number {
  // Stops are measured from the paragraph's left indent; x is from the line's left.
  const pos = lineLeft - left + x;
  const stops = (props.tabs ?? []).filter((t) => t.pos > pos + EPS).sort((a, b) => a.pos - b.pos);
  const stop: TabStop = stops[0] ?? { pos: (Math.floor(pos / ctx.tabInterval + EPS) + 1) * ctx.tabInterval, align: 'left' };
  const item = items[i]!;
  if (item.kind === 'tab' && stop.leader && stop.leader !== 'none') item.leader = stop.leader;
  let w = stop.pos - pos;
  if (stop.align !== 'left') {
    // Width of what follows up to the next tab or line end.
    let seg = 0;
    let beforeDecimal = 0;
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j]!;
      if (next.kind === 'tab' || next.kind === 'break' || next.kind === 'mark') break;
      if (stop.align === 'decimal' && next.kind === 'text' && beforeDecimal === 0) {
        const dot = next.text.search(/[.,]/);
        if (dot >= 0) beforeDecimal = seg + ctx.measurer.measure(next.text.slice(0, dot), next.style.font);
      }
      seg += next.width - (next.kind === 'text' ? next.trail : 0);
    }
    const shift = stop.align === 'right' ? seg : stop.align === 'center' ? seg / 2 : beforeDecimal || seg;
    w -= shift;
  }
  if (x + w > avail) w = Math.max(0, avail - x);
  return Math.max(0, w);
}

// ---------------------------------------------------------------- lines

function buildLine(
  ctx: ParagraphContext,
  items: Item[],
  reason: 'wrap' | 'last' | 'forced',
  props: ParaProps,
  lineLeft: number,
  avail: number,
  marker: LineLayout['marker'],
  extra: Partial<LineLayout>,
): LineLayout {
  // Visible width: without the hanging trailing spaces of the last text piece.
  let width = 0;
  let lastText = -1;
  for (let i = 0; i < items.length; i++) {
    width += items[i]!.width;
    if (items[i]!.kind === 'text') lastText = i;
  }
  const trailingItem = lastText >= 0 && items.slice(lastText + 1).every((it) => (it.kind === 'mark' || it.kind === 'break') || (it.kind === 'object' && it.width === 0)) ? (items[lastText] as Extract<Item, { kind: 'text' }>) : null;
  const visible = width - (trailingItem?.trail ?? 0);

  // Justified lines stretch their spaces (not on the last line or before a forced break).
  let wordSpacing = 0;
  const align = props.align ?? 'left';
  if (align === 'justify' && reason === 'wrap') {
    let spaces = 0;
    for (const it of items) if (it.kind === 'text') spaces += countSpaces(it.text);
    if (trailingItem) spaces -= trailingItem.trailSpaces;
    if (spaces > 0) wordSpacing = Math.max(0, (avail - visible) / spaces);
  }

  // Runs: neighbouring text pieces of one style become one run.
  const runs: RunLayout[] = [];
  let rx = 0;
  let maxAscent = 0;
  let maxDescent = 0;
  const measure = (style: RunStyle) => {
    const m = ctx.measurer.metrics(style.font);
    const shift = style.baselineShift ?? 0;
    maxAscent = Math.max(maxAscent, m.ascent + Math.max(0, shift));
    maxDescent = Math.max(maxDescent, m.descent - Math.min(0, shift));
  };
  for (const it of items) {
    if (it.kind === 'text') {
      const last = runs[runs.length - 1];
      const stretch = wordSpacing * countSpaces(it.text);
      if (last && last.kind === 'text' && last.style === it.style && last.end === it.start) {
        last.text += it.text;
        last.end = it.end;
        last.width += it.width + stretch;
      } else {
        const run: RunLayout = { kind: 'text', start: it.start, end: it.end, x: rx, width: it.width + stretch, style: it.style, text: it.text };
        if (wordSpacing) run.wordSpacing = wordSpacing;
        runs.push(run);
      }
      rx += it.width + stretch;
      measure(it.style);
    } else if (it.kind === 'object') {
      const run: RunLayout = { kind: 'object', start: it.start, end: it.end, x: rx, width: it.width, style: it.style, object: it.object, objectAscent: it.ascent };
      if (it.text !== undefined) run.text = it.text;
      runs.push(run);
      rx += it.width;
      if (it.object.kind === 'image') {
        maxAscent = Math.max(maxAscent, it.ascent);
        maxDescent = Math.max(maxDescent, it.descent);
      } else measure(it.style);
    } else {
      const run: RunLayout = { kind: it.kind === 'tab' ? 'tab' : it.kind, start: it.start, end: it.end, x: rx, width: it.width, style: it.style };
      if (it.kind === 'tab' && it.leader) run.leader = it.leader;
      runs.push(run);
      rx += it.width;
      measure(it.style);
    }
  }
  if (marker) measure(marker.style);
  if (maxAscent === 0 && maxDescent === 0 && items[0]) measure(items[0].style);

  const natural = maxAscent + maxDescent;
  let height: number;
  let ascent: number;
  if (props.lineHeightExact) {
    height = props.lineHeightExact;
    ascent = maxAscent + (height - natural) / 2;
  } else {
    height = natural * (props.lineHeight ?? 1);
    ascent = maxAscent + (height - natural) / 2;
  }
  if (extra.rule) {
    height = Math.max(height, RULE_HEIGHT);
    ascent = height / 2;
  }

  let x = lineLeft;
  if (align === 'center') x += Math.max(0, (avail - visible) / 2);
  else if (align === 'right') x += Math.max(0, avail - visible);

  const footnotes = items.filter((it): it is Extract<Item, { kind: 'object' }> => it.kind === 'object' && it.object.kind === 'footnote').map((it) => (it.object as { id: string }).id);
  const line: LineLayout = {
    start: items[0]?.start ?? 0,
    end: items[items.length - 1]?.end ?? 0,
    x,
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

function countSpaces(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) n++;
  return n;
}

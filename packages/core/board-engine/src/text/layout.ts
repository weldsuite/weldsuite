/**
 * Lays an element's rich text out in a box: paragraphs broken into lines at
 * Unicode break opportunities (docs-engine's `canBreakBefore`), measured by
 * docs-engine's `TextMeasurer` (canvas in the browser, built-in metrics in
 * workers), aligned, and optionally shrunk to fit (stickies).
 *
 * The same layout draws the text, places the caret while editing, and
 * answers which character is under the pointer, so editing never jumps.
 */

import { canBreakBefore, type FontSpec, type TextMeasurer } from '@weldsuite/docs-engine';
import { fullRuns } from '../model/text';
import type { Marks, RichText, TextAlign, VerticalAlign } from '../model/types';

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  align: TextAlign;
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
}

export interface LaidRun {
  text: string;
  /** Offset of the run in the element's text. */
  start: number;
  /** Left edge relative to the line. */
  x: number;
  width: number;
  font: FontSpec;
  marks: Marks;
}

export interface LaidLine {
  /** Offsets [start, end) of the characters on this line (end excludes a trailing `\n`). */
  start: number;
  end: number;
  /** Left edge (after alignment) and top, relative to the layout box. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline, relative to the layout box's top. */
  baseline: number;
  runs: LaidRun[];
  /** Character x-positions within the line, relative to `x`: one per offset from start to end inclusive. */
  carets: number[];
}

export interface TextLayout {
  lines: LaidLine[];
  width: number;
  height: number;
  fontSize: number;
}

interface Piece {
  text: string;
  start: number;
  marks: Marks;
}

function fontFor(style: TextStyle, size: number, marks: Marks): FontSpec {
  return { family: style.fontFamily, size, bold: !!marks.b, italic: !!marks.i };
}

/** Pieces of a paragraph where marks change. */
function piecesOf(text: RichText, from: number, to: number): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  for (const [len, marks] of fullRuns(text)) {
    const a = Math.max(pos, from);
    const b = Math.min(pos + len, to);
    if (b > a) out.push({ text: text.text.slice(a, b), start: a, marks });
    pos += len;
  }
  if (out.length === 0 && to > from) out.push({ text: text.text.slice(from, to), start: from, marks: {} });
  return out;
}

export function layoutText(text: RichText, style: TextStyle, width: number, measurer: TextMeasurer, size = style.fontSize): TextLayout {
  const lineHeight = (style.lineHeight ?? 1.3) * size;
  const lines: LaidLine[] = [];
  const maxWidth = Math.max(1, width);
  let y = 0;
  let paraStart = 0;
  const full = text.text;
  for (;;) {
    const nl = full.indexOf('\n', paraStart);
    const paraEnd = nl === -1 ? full.length : nl;
    for (const line of breakParagraph(text, paraStart, paraEnd, style, size, maxWidth, measurer)) {
      const metrics = measurer.metrics(fontFor(style, size, {}));
      const height = Math.max(lineHeight, metrics.ascent + metrics.descent);
      const baseline = y + (height - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
      const x = style.align === 'center' ? (maxWidth - line.width) / 2 : style.align === 'right' ? maxWidth - line.width : 0;
      lines.push({ ...line, x, y, height, baseline });
      y += height;
    }
    if (nl === -1) break;
    paraStart = nl + 1;
  }
  const w = lines.reduce((m, l) => Math.max(m, l.width), 0);
  return { lines, width: w, height: y, fontSize: size };
}

type Broken = Omit<LaidLine, 'x' | 'y' | 'height' | 'baseline'>;

function breakParagraph(
  text: RichText,
  from: number,
  to: number,
  style: TextStyle,
  size: number,
  maxWidth: number,
  measurer: TextMeasurer,
): Broken[] {
  const para = text.text.slice(from, to);
  if (para.length === 0) return [{ start: from, end: from, width: 0, runs: [], carets: [0] }];
  const pieces = piecesOf(text, from, to);
  // Per-character advances (cached by the measurer, so repeated characters cost nothing).
  // A surrogate pair is measured whole on its first unit.
  const advances: number[] = [];
  for (const p of pieces) {
    const font = fontFor(style, size, p.marks);
    for (let i = 0; i < p.text.length; i++) {
      const code = p.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < p.text.length) {
        advances.push(measurer.measure(p.text.slice(i, i + 2), font), 0);
        i++;
      } else advances.push(measurer.measure(p.text[i]!, font));
    }
  }
  const lines: Broken[] = [];
  let lineStart = 0;
  let lineWidth = 0;
  let lastBreak = -1;
  let widthAtBreak = 0;
  for (let i = 0; i < para.length; i++) {
    if (i > lineStart && canBreakBefore(para, i)) {
      lastBreak = i;
      widthAtBreak = lineWidth;
    }
    const adv = advances[i] ?? 0;
    const isSpace = para[i] === ' ';
    if (lineWidth + adv > maxWidth && i > lineStart && !isSpace) {
      const breakAt = lastBreak > lineStart ? lastBreak : i;
      lines.push(makeLine(text, from, lineStart, breakAt, advances, style, size, pieces));
      lineStart = breakAt;
      lineWidth = breakAt === i ? 0 : lineWidth - widthAtBreak;
      lastBreak = -1;
      if (breakAt !== i) {
        // Recount the carried-over part exactly.
        lineWidth = 0;
        for (let k = lineStart; k < i; k++) lineWidth += advances[k] ?? 0;
      }
    }
    lineWidth += adv;
  }
  lines.push(makeLine(text, from, lineStart, para.length, advances, style, size, pieces));
  return lines;
}

function makeLine(
  text: RichText,
  paraOffset: number,
  start: number,
  end: number,
  advances: number[],
  style: TextStyle,
  size: number,
  pieces: Piece[],
): Broken {
  const carets: number[] = [0];
  let x = 0;
  for (let i = start; i < end; i++) {
    x += advances[i] ?? 0;
    carets.push(x);
  }
  // Trailing spaces hang: they do not count for alignment.
  let visibleEnd = end;
  while (visibleEnd > start && text.text[paraOffset + visibleEnd - 1] === ' ') visibleEnd--;
  const width = carets[visibleEnd - start] ?? 0;
  const runs: LaidRun[] = [];
  for (const p of pieces) {
    const a = Math.max(p.start - paraOffset, start);
    const b = Math.min(p.start - paraOffset + p.text.length, end);
    if (b <= a) continue;
    runs.push({
      text: text.text.slice(paraOffset + a, paraOffset + b),
      start: paraOffset + a,
      x: carets[a - start] ?? 0,
      width: (carets[b - start] ?? 0) - (carets[a - start] ?? 0),
      font: fontFor(style, size, p.marks),
      marks: p.marks,
    });
  }
  return { start: paraOffset + start, end: paraOffset + end, width, runs, carets };
}

/**
 * The largest font size, at most the style's, at which the text fits the
 * box (stickies shrink as you type). Never below `min`.
 */
export function fitText(text: RichText, style: TextStyle, width: number, height: number, measurer: TextMeasurer, min = 8): TextLayout {
  let layout = layoutText(text, style, width, measurer);
  if (layout.height <= height && layout.lines.every((l) => l.width <= width + 0.5)) return layout;
  let lo = min;
  let hi = style.fontSize;
  let best = layoutText(text, style, width, measurer, min);
  for (let i = 0; i < 8 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    layout = layoutText(text, style, width, measurer, mid);
    if (layout.height <= height && layout.lines.every((l) => l.width <= width + 0.5)) {
      best = layout;
      lo = mid;
    } else hi = mid;
  }
  return best;
}

/** Vertical offset of a layout in a box of `height`. */
export function verticalOffset(layout: TextLayout, height: number, align: VerticalAlign | undefined): number {
  if (align === 'middle') return (height - layout.height) / 2;
  if (align === 'bottom') return height - layout.height;
  return 0;
}

/** The caret rectangle for an offset, relative to the layout box. */
export function caretRect(layout: TextLayout, pos: number): { x: number; y: number; h: number } {
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i]!;
    const next = layout.lines[i + 1];
    // A position at a line's end belongs to the next line when that line starts there (wrapped).
    if (pos >= line.start && (pos < line.end || (pos === line.end && (!next || next.start !== pos)))) {
      return { x: line.x + (line.carets[pos - line.start] ?? line.width), y: line.y, h: line.height };
    }
  }
  const last = layout.lines[layout.lines.length - 1];
  if (!last) return { x: 0, y: 0, h: layout.fontSize * 1.3 };
  return { x: last.x + (last.carets[last.carets.length - 1] ?? 0), y: last.y, h: last.height };
}

/** The offset nearest to a point (relative to the layout box). */
export function offsetAt(layout: TextLayout, x: number, y: number): number {
  if (layout.lines.length === 0) return 0;
  let line = layout.lines[layout.lines.length - 1]!;
  for (const l of layout.lines) {
    if (y < l.y + l.height) {
      line = l;
      break;
    }
  }
  const rel = x - line.x;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < line.carets.length; i++) {
    const d = Math.abs(line.carets[i]! - rel);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return line.start + best;
}

/** Rectangles covering [from, to), relative to the layout box. */
export function selectionRects(layout: TextLayout, from: number, to: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  if (from === to) return out;
  for (const line of layout.lines) {
    const a = Math.max(from, line.start);
    const b = Math.min(to, line.end);
    if (b < a || (b === a && !(from < line.start && to > line.end))) continue;
    const xa = line.carets[a - line.start] ?? 0;
    const xb = line.carets[b - line.start] ?? line.width;
    out.push({ x: line.x + xa, y: line.y, w: Math.max(2, xb - xa), h: line.height });
  }
  return out;
}

/** The line a position is on and the one above or below, for Up/Down keys. */
export function verticalMove(layout: TextLayout, pos: number, dir: -1 | 1, goalX?: number): { pos: number; x: number } {
  const caret = caretRect(layout, pos);
  const x = goalX ?? caret.x;
  const index = layout.lines.findIndex((l) => caret.y >= l.y && caret.y < l.y + l.height);
  const target = layout.lines[index + dir];
  if (!target) return { pos: dir < 0 ? 0 : (layout.lines.at(-1)?.end ?? pos), x };
  return { pos: offsetAt(layout, x, target.y + target.height / 2), x };
}

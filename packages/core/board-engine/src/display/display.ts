/**
 * What an element looks like, as a flat list of draw items: paths, text
 * runs and images, in board units. The canvas renderer, the SVG writer and
 * the PDF writer all draw from this list, so an export looks like the board.
 *
 * Live data that is not on the board (people's names, a record's title, an
 * image's address) comes in through `DisplayOptions` resolvers.
 */

import type { FontSpec, TextMeasurer } from '@weldsuite/docs-engine';
import { penPoints } from '../geometry/bounds';
import { capPath, connectorGeometry } from '../geometry/connectors';
import { placePath, roundedRectPath, smoothPath, type PathCmd } from '../geometry/path';
import { shapeOutline, textBox } from '../geometry/shapes';
import type { Board } from '../model/board';
import { DEFAULT_FONT, DEFAULT_FONT_SIZE, DEFAULT_STROKE, DEFAULT_TEXT } from '../model/defaults';
import { plain } from '../model/text';
import type { BoardElement, RecordRef, RichText } from '../model/types';
import { fitText, layoutText, verticalOffset, type TextLayout, type TextStyle } from '../text/layout';

export type DisplayItem =
  | {
      kind: 'path';
      cmds: PathCmd[];
      fill?: string;
      stroke?: string;
      width?: number;
      dash?: number[];
      opacity?: number;
      shadow?: boolean;
      round?: boolean;
    }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      font: FontSpec;
      color: string;
      width: number;
      underline?: boolean;
      strike?: boolean;
      highlight?: { color: string; h: number };
      link?: string;
    }
  | { kind: 'image'; x: number; y: number; w: number; h: number; src: string; crop?: { x: number; y: number; w: number; h: number } | null; radius?: number }
  | { kind: 'group'; rotate: { cx: number; cy: number; angle: number } | null; clip?: PathCmd[]; opacity?: number; items: DisplayItem[] };

export interface RecordView {
  title: string;
  subtitle?: string;
  status?: string;
  color?: string;
  kindLabel?: string;
}

export interface DisplayOptions {
  measurer: TextMeasurer;
  /** A person's display name by user id. */
  name?: (userId: string) => string | null;
  /** A WeldSuite record's current title and status. */
  record?: (ref: RecordRef) => RecordView | null;
  /** The address to load an image from (resolves `drive:` sources). */
  imageSrc?: (src: string) => string | null;
  /** Show who wrote each sticky. */
  showAuthors?: boolean;
  /** Text shown in an empty sticky or shape while editing it is off (placeholders are the editor's business). */
  emptyText?: string;
}

function rectItem(x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string, width?: number, shadow?: boolean): DisplayItem {
  return { kind: 'path', cmds: roundedRectPath(x, y, w, h, r), fill, stroke, width, shadow };
}

function textStyle(el: BoardElement, fallbackSize: number, align?: TextStyle['align']): TextStyle {
  return {
    fontFamily: el.fontFamily ?? DEFAULT_FONT,
    fontSize: el.fontSize ?? fallbackSize,
    color: el.textColor ?? DEFAULT_TEXT,
    align: align ?? el.textAlign ?? 'left',
  };
}

/** Draw items for a laid-out text, placed at (x, y). */
export function textItems(layout: TextLayout, x: number, y: number, color: string): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const line of layout.lines) {
    for (const run of line.runs) {
      if (!run.text) continue;
      const item: DisplayItem = {
        kind: 'text',
        x: x + line.x + run.x,
        y: y + line.baseline,
        text: run.text,
        font: run.font,
        color: run.marks.c ?? (run.marks.a || run.marks.m ? '#2563eb' : color),
        width: run.width,
      };
      if (run.marks.u || run.marks.a) item.underline = true;
      if (run.marks.s) item.strike = true;
      if (run.marks.h) item.highlight = { color: run.marks.h, h: line.height };
      if (run.marks.a) item.link = run.marks.a;
      out.push(item);
    }
  }
  return out;
}

/** Lays out an element's text for its text box (the same layout the editor edits). */
export function elementTextLayout(el: BoardElement, options: Pick<DisplayOptions, 'measurer'>): { layout: TextLayout; x: number; y: number; style: TextStyle } | null {
  const box = elementTextBox(el);
  if (!box) return null;
  const text = el.text ?? plain();
  const style = textStyle(el, el.type === 'sticky' ? 22 : DEFAULT_FONT_SIZE, el.type === 'sticky' ? (el.textAlign ?? 'center') : undefined);
  const layout =
    el.autoFit || el.type === 'sticky'
      ? fitText(text, style, box.w, box.h, options.measurer)
      : layoutText(text, style, box.w, options.measurer);
  const vAlign = el.vAlign ?? (el.type === 'shape' || el.type === 'sticky' ? 'middle' : 'top');
  return { layout, x: box.x, y: box.y + verticalOffset(layout, box.h, vAlign), style };
}

/** The box text goes in, in board units (unrotated). */
export function elementTextBox(el: BoardElement): { x: number; y: number; w: number; h: number } | null {
  switch (el.type) {
    case 'sticky': {
      const pad = Math.max(10, el.w * 0.08);
      return { x: el.x + pad, y: el.y + pad, w: el.w - pad * 2, h: el.h - pad * 2 - (el.createdBy ? 14 : 0) };
    }
    case 'shape': {
      const b = textBox(el.shape, el.w, el.h);
      return { x: el.x + b.x, y: el.y + b.y, w: b.w, h: b.h };
    }
    case 'text':
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case 'card':
      return { x: el.x + 16, y: el.y + 12, w: el.w - 32, h: Math.min(44, el.h - 24) };
    default:
      return null;
  }
}

export function elementDisplay(board: Board, el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const items = rawDisplay(board, el, options);
  const needsGroup = (el.rotation && el.type !== 'connector' && el.type !== 'pen') || (el.opacity !== undefined && el.opacity < 1);
  if (!needsGroup) return items;
  return [
    {
      kind: 'group',
      rotate: el.rotation && el.type !== 'connector' && el.type !== 'pen' ? { cx: el.x + el.w / 2, cy: el.y + el.h / 2, angle: el.rotation } : null,
      ...(el.opacity !== undefined && el.opacity < 1 ? { opacity: el.opacity } : {}),
      items,
    },
  ];
}

function rawDisplay(board: Board, el: BoardElement, options: DisplayOptions): DisplayItem[] {
  switch (el.type) {
    case 'sticky':
      return stickyDisplay(el, options);
    case 'shape':
      return shapeDisplay(el, options);
    case 'text': {
      const t = elementTextLayout(el, options);
      const out: DisplayItem[] = [];
      if (el.fill && el.fill !== 'transparent') out.push(rectItem(el.x, el.y, el.w, el.h, 4, el.fill));
      if (t) out.push(...textItems(t.layout, t.x, t.y, t.style.color));
      return out;
    }
    case 'connector':
      return connectorDisplay(board, el, options);
    case 'pen': {
      const pts = penPoints(el);
      const highlighter = el.pen === 'highlighter';
      return [
        {
          kind: 'path',
          cmds: smoothPath(pts),
          stroke: el.stroke ?? (highlighter ? '#fde047' : DEFAULT_STROKE),
          width: el.strokeWidth ?? (highlighter ? 16 : 3),
          opacity: highlighter ? 0.45 : undefined,
          round: true,
        },
      ];
    }
    case 'image': {
      const src = el.src ? (options.imageSrc ? options.imageSrc(el.src) : el.src) : null;
      const out: DisplayItem[] = [];
      if (src) out.push({ kind: 'image', x: el.x, y: el.y, w: el.w, h: el.h, src, crop: el.crop ?? null, radius: el.radius });
      else out.push(rectItem(el.x, el.y, el.w, el.h, el.radius ?? 0, '#f3f4f6', '#d1d5db', 1));
      if (el.stroke && el.strokeWidth) out.push(rectItem(el.x, el.y, el.w, el.h, el.radius ?? 0, undefined, el.stroke, el.strokeWidth));
      return out;
    }
    case 'file':
      return cardLike(el, options, el.fileName ?? 'File', [el.mime, el.size ? formatSize(el.size) : undefined].filter(Boolean).join(' · '), '#64748b');
    case 'frame':
      return frameDisplay(el, options);
    case 'group':
      return [];
    case 'card':
      return cardDisplay(el, options);
    case 'record': {
      const view = el.record ? options.record?.(el.record) : null;
      const title = view?.title ?? (el.record ? `${el.record.kind}` : 'Record');
      const subtitle = [view?.kindLabel ?? el.record?.kind, view?.subtitle, view?.status].filter(Boolean).join(' · ');
      return cardLike(el, options, title, subtitle, view?.color ?? '#6366f1');
    }
    case 'link':
      return cardLike(el, options, el.title || el.link || 'Link', [el.siteName, el.description].filter(Boolean).join(' · '), '#0ea5e9');
    case 'comment':
      return commentDisplay(el);
  }
}

function stickyDisplay(el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const out: DisplayItem[] = [rectItem(el.x, el.y, el.w, el.h, 2, el.fill ?? '#fff9b1', undefined, undefined, true)];
  const t = elementTextLayout(el, options);
  if (t) out.push(...textItems(t.layout, t.x, t.y, t.style.color));
  if (options.showAuthors && el.createdBy) {
    const name = options.name?.(el.createdBy);
    if (name) {
      const size = Math.max(9, el.w * 0.055);
      const font = { family: DEFAULT_FONT, size, bold: false, italic: false };
      out.push({ kind: 'text', x: el.x + el.w * 0.06, y: el.y + el.h - el.w * 0.05, text: name, font, color: '#6b7280', width: options.measurer.measure(name, font) });
    }
  }
  return out;
}

function shapeDisplay(el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const outline = placePath(shapeOutline(el.shape ?? 'rectangle', el.w, el.h, el.radius ?? 0), el.x, el.y, el.w, el.h);
  const out: DisplayItem[] = [
    {
      kind: 'path',
      cmds: outline,
      fill: el.fill === 'transparent' ? undefined : el.fill,
      stroke: el.stroke === 'transparent' ? undefined : (el.stroke ?? DEFAULT_STROKE),
      width: el.strokeWidth ?? 2,
      dash: dashFor(el),
    },
  ];
  const t = elementTextLayout(el, options);
  if (t) out.push(...textItems(t.layout, t.x, t.y, t.style.color));
  return out;
}

function dashFor(el: BoardElement): number[] | undefined {
  const w = el.strokeWidth ?? 2;
  if (el.strokeStyle === 'dashed') return [w * 4, w * 3];
  if (el.strokeStyle === 'dotted') return [w, w * 2];
  return undefined;
}

function connectorDisplay(board: Board, el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const g = connectorGeometry(board, el);
  const stroke = el.stroke ?? DEFAULT_STROKE;
  const width = el.strokeWidth ?? 2;
  const out: DisplayItem[] = [{ kind: 'path', cmds: g.cmds, stroke, width, dash: dashFor(el), round: el.route !== 'elbow' }];
  const end = el.endCap ? capPath(el.endCap, g.end.p, g.endAngle, width) : null;
  const start = el.startCap ? capPath(el.startCap, g.start.p, g.startAngle, width) : null;
  for (const cap of [end, start]) {
    if (!cap) continue;
    out.push({ kind: 'path', cmds: cap.cmds, stroke, width, fill: cap.filled ? stroke : undefined, round: true });
  }
  if (el.text?.text) {
    const style: TextStyle = { fontFamily: el.fontFamily ?? DEFAULT_FONT, fontSize: el.fontSize ?? 14, color: el.textColor ?? DEFAULT_TEXT, align: 'center' };
    const layout = layoutText(el.text, style, 220, options.measurer);
    const w = layout.width + 12;
    const h = layout.height + 6;
    out.push(rectItem(g.label.x - w / 2, g.label.y - h / 2, w, h, 4, '#ffffff'));
    out.push(...textItems(layout, g.label.x - 110, g.label.y - layout.height / 2, style.color));
  }
  return out;
}

const FRAME_TITLE_SIZE = 14;

function frameDisplay(el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const out: DisplayItem[] = [rectItem(el.x, el.y, el.w, el.h, el.radius ?? 0, el.fill ?? '#ffffff', el.stroke ?? '#d1d5db', 1)];
  const title = el.name || '';
  if (title) {
    const font = { family: DEFAULT_FONT, size: FRAME_TITLE_SIZE, bold: true, italic: false };
    out.push({ kind: 'text', x: el.x, y: el.y - 8, text: title, font, color: '#4b5563', width: options.measurer.measure(title, font) });
  }
  return out;
}

function cardDisplay(el: BoardElement, options: DisplayOptions): DisplayItem[] {
  const accent = el.stroke ?? '#3b82f6';
  const out: DisplayItem[] = [
    rectItem(el.x, el.y, el.w, el.h, el.radius ?? 8, el.fill ?? '#ffffff', '#e5e7eb', 1, true),
    { kind: 'path', cmds: roundedRectPath(el.x, el.y, 6, el.h, 3), fill: accent },
  ];
  const t = elementTextLayout({ ...el, fontSize: el.fontSize ?? 16, text: el.text ?? plain() }, options);
  if (t) {
    const bold = { ...t.layout, lines: t.layout.lines.map((l) => ({ ...l, runs: l.runs.map((r) => ({ ...r, font: { ...r.font, bold: true } })) })) };
    out.push(...textItems(bold, t.x, t.y, t.style.color));
  }
  const meta: string[] = [];
  if (el.assignee) meta.push(options.name?.(el.assignee) ?? '');
  if (el.due) meta.push(el.due);
  if (el.tags?.length) meta.push(el.tags.map((x) => `#${x}`).join(' '));
  if (el.description) {
    const style: TextStyle = { fontFamily: DEFAULT_FONT, fontSize: 13, color: '#4b5563', align: 'left' };
    const layout = layoutText(plain(el.description), style, el.w - 32, options.measurer);
    const maxLines = Math.max(0, Math.floor((el.h - 76) / (13 * 1.3)));
    const clipped = { ...layout, lines: layout.lines.slice(0, maxLines) };
    out.push(...textItems(clipped, el.x + 16, el.y + 56, style.color));
  }
  const metaText = meta.filter(Boolean).join('  ·  ');
  if (metaText) {
    const font = { family: DEFAULT_FONT, size: 12, bold: false, italic: false };
    out.push({ kind: 'text', x: el.x + 16, y: el.y + el.h - 12, text: metaText, font, color: '#6b7280', width: options.measurer.measure(metaText, font) });
  }
  return out;
}

function cardLike(el: BoardElement, options: DisplayOptions, title: string, subtitle: string, accent: string): DisplayItem[] {
  const out: DisplayItem[] = [
    rectItem(el.x, el.y, el.w, el.h, 8, el.fill ?? '#ffffff', '#e5e7eb', 1, true),
    { kind: 'path', cmds: roundedRectPath(el.x, el.y, 6, el.h, 3), fill: accent },
  ];
  const titleStyle: TextStyle = { fontFamily: DEFAULT_FONT, fontSize: 15, color: DEFAULT_TEXT, align: 'left' };
  const tl = layoutText({ text: title, marks: [[title.length, { b: true }]] } as RichText, titleStyle, el.w - 32, options.measurer);
  out.push(...textItems({ ...tl, lines: tl.lines.slice(0, 2) }, el.x + 16, el.y + 14, DEFAULT_TEXT));
  if (subtitle) {
    const style: TextStyle = { fontFamily: DEFAULT_FONT, fontSize: 12, color: '#6b7280', align: 'left' };
    const sl = layoutText(plain(subtitle), style, el.w - 32, options.measurer);
    out.push(...textItems({ ...sl, lines: sl.lines.slice(0, 2) }, el.x + 16, el.y + Math.min(el.h - 36, 14 + Math.min(2, tl.lines.length) * 20 + 6), '#6b7280'));
  }
  return out;
}

function commentDisplay(el: BoardElement): DisplayItem[] {
  const s = 28;
  const x = el.x;
  const y = el.y - s;
  const color = el.resolved ? '#9ca3af' : '#f59e0b';
  return [
    {
      kind: 'path',
      cmds: [
        ['M', x, y + s],
        ['L', x, y + s * 0.35],
        ['C', x, y + s * 0.15, x + s * 0.15, y, x + s * 0.35, y],
        ['L', x + s * 0.65, y],
        ['C', x + s * 0.85, y, x + s, y + s * 0.15, x + s, y + s * 0.35],
        ['L', x + s, y + s * 0.65],
        ['C', x + s, y + s * 0.85, x + s * 0.85, y + s, x + s * 0.65, y + s],
        ['Z'],
      ],
      fill: color,
      stroke: '#ffffff',
      width: 2,
      shadow: true,
    },
  ];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The whole board (or the elements given), in paint order. */
export function boardDisplay(board: Board, options: DisplayOptions, only?: ReadonlySet<string>): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const el of board.paintOrder()) {
    if (only && !only.has(el.id)) continue;
    out.push(...elementDisplay(board, el, options));
  }
  return out;
}

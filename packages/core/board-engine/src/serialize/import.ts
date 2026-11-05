/**
 * Imports that become fragments: an Excalidraw file, and text or CSV lines
 * as sticky notes. The editor places the fragment at the viewport centre;
 * the board-api import route places it on a new board.
 */

import { keysBetween } from '../model/order';
import { STICKY_COLORS, STICKY_SIZE } from '../model/defaults';
import { plain } from '../model/text';
import type { BoardElement, Cap, ShapeKind } from '../model/types';
import type { Fragment } from './fragment';

const MAX_IMPORT = 10_000;

function fragmentOf(elements: BoardElement[]): Fragment {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  if (!elements.length) return { kind: 'weldboard-fragment', version: 1, elements: [], width: 0, height: 0 };
  for (const el of elements) {
    el.x -= minX;
    el.y -= minY;
    if (el.start) el.start = { ...el.start, x: el.start.x - minX, y: el.start.y - minY };
    if (el.end) el.end = { ...el.end, x: el.end.x - minX, y: el.end.y - minY };
  }
  return { kind: 'weldboard-fragment', version: 1, elements, width: maxX - minX, height: maxY - minY };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function color(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (s === 'transparent') return 'transparent';
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : undefined;
}

const SAFE_ID = /[^A-Za-z0-9_:-]/g;

/** What every element converted from one Excalidraw element starts from. */
interface ExcalidrawBase {
  /** Id, order key, box and rotation. */
  base: Pick<BoardElement, 'id' | 'order' | 'x' | 'y' | 'w' | 'h' | 'rotation'>;
  /** The frame it sits in, when that came across. */
  parent: { parent?: string };
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string | undefined;
  fill: string | undefined;
}

/** Excalidraw arrowheads as caps. */
const EXCALIDRAW_CAPS = new Map<unknown, Cap>([
  ['arrow', 'arrow'],
  ['triangle', 'arrow'],
  ['dot', 'circle'],
  ['circle', 'circle'],
  ['bar', 'bar'],
]);

function excalidrawCap(v: unknown): Cap {
  return EXCALIDRAW_CAPS.get(v) ?? 'none';
}

function excalidrawPoints(e: Record<string, unknown>): number[][] {
  return Array.isArray(e.points) ? ((e.points as unknown[]).filter(Array.isArray) as number[][]) : [];
}

function excalidrawShapeKind(e: Record<string, unknown>): ShapeKind {
  if (e.type !== 'rectangle') return e.type as ShapeKind;
  return e.roundness ? 'rounded' : 'rectangle';
}

function excalidrawRoute(e: Record<string, unknown>, points: number[][]): BoardElement['route'] {
  if (e.elbowed) return 'elbow';
  return points.length > 2 ? 'curved' : 'straight';
}

function excalidrawShape(e: Record<string, unknown>, b: ExcalidrawBase): BoardElement {
  return {
    ...b.base,
    ...b.parent,
    type: 'shape',
    shape: excalidrawShapeKind(e),
    fill: b.fill ?? 'transparent',
    stroke: b.stroke ?? '#1e1e1e',
    strokeWidth: Math.max(1, num(e.strokeWidth, 2)),
    ...(e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted' ? { strokeStyle: e.strokeStyle } : {}),
  };
}

/** Text bound inside a shape becomes the shape's text; other text a text element. */
function addExcalidrawText(e: Record<string, unknown>, b: ExcalidrawBase, ids: Map<string, string>, out: BoardElement[]): void {
  const text = str(e.text) ?? '';
  if (typeof e.containerId === 'string') {
    const container = out.find((o) => o.id === ids.get(String(e.containerId)));
    if (container && container.type === 'shape') {
      container.text = plain(text);
      container.fontSize = num(e.fontSize, 16);
      return;
    }
  }
  out.push({
    ...b.base,
    ...b.parent,
    w: Math.max(b.w, 20),
    h: Math.max(b.h, 20),
    type: 'text',
    text: plain(text),
    fontSize: num(e.fontSize, 20),
    textColor: b.stroke ?? '#1e1e1e',
    textAlign: e.textAlign === 'center' || e.textAlign === 'right' ? e.textAlign : 'left',
  });
}

function excalidrawLine(e: Record<string, unknown>, b: ExcalidrawBase, ids: Map<string, string>): BoardElement {
  const points = excalidrawPoints(e);
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? [b.w, b.h];
  const bind = (binding: unknown) => {
    const id2 = (binding as { elementId?: unknown } | null)?.elementId;
    return typeof id2 === 'string' && ids.has(id2) ? { el: ids.get(id2)!, side: 'auto' as const } : {};
  };
  return {
    ...b.base,
    ...b.parent,
    type: 'connector',
    start: { x: b.x + num(first[0]), y: b.y + num(first[1]), ...bind(e.startBinding) },
    end: { x: b.x + num(last[0]), y: b.y + num(last[1]), ...bind(e.endBinding) },
    route: excalidrawRoute(e, points),
    startCap: excalidrawCap(e.startArrowhead),
    endCap: e.type === 'arrow' ? excalidrawCap(e.endArrowhead ?? 'arrow') : 'none',
    stroke: b.stroke ?? '#1e1e1e',
    strokeWidth: Math.max(1, num(e.strokeWidth, 2)),
  };
}

function excalidrawPen(e: Record<string, unknown>, b: ExcalidrawBase): BoardElement {
  const points = excalidrawPoints(e);
  const pressures = Array.isArray(e.pressures) ? (e.pressures as number[]) : [];
  const flat: number[] = [];
  points.slice(0, 30_000).forEach((p, i) => flat.push(num(p[0]), num(p[1]), num(pressures[i], 0.5)));
  return { ...b.base, ...b.parent, type: 'pen', points: flat, stroke: b.stroke ?? '#1e1e1e', strokeWidth: Math.max(1, num(e.strokeWidth, 2)) };
}

/** Adds what one Excalidraw element becomes; false when its type does not come across. */
function addExcalidraw(e: Record<string, unknown>, b: ExcalidrawBase, ids: Map<string, string>, out: BoardElement[]): boolean {
  switch (e.type) {
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      out.push(excalidrawShape(e, b));
      return true;
    case 'text':
      addExcalidrawText(e, b, ids, out);
      return true;
    case 'arrow':
    case 'line':
      out.push(excalidrawLine(e, b, ids));
      return true;
    case 'freedraw':
      out.push(excalidrawPen(e, b));
      return true;
    case 'frame':
    case 'magicframe':
      out.push({ ...b.base, type: 'frame', name: str(e.name) ?? 'Frame', fill: '#ffffff' });
      return true;
    default:
      return false;
  }
}

/**
 * An Excalidraw scene (`.excalidraw` JSON) as a fragment. Rectangles,
 * ellipses, diamonds, text, arrows and lines, free drawing and frames come
 * across; embedded images do not (they would need uploading first).
 */
export function fromExcalidraw(json: unknown, makeId: () => string): { fragment: Fragment; skipped: number } {
  const scene = json as { elements?: unknown[] };
  const src = Array.isArray(scene?.elements) ? scene.elements.slice(0, MAX_IMPORT) : [];
  const ids = new Map<string, string>();
  for (const raw of src) {
    const e = raw as Record<string, unknown>;
    if (typeof e.id === 'string') ids.set(e.id, makeId());
  }
  const out: BoardElement[] = [];
  let skipped = 0;
  const keys = keysBetween(null, null, src.length || 1);
  src.forEach((raw, index) => {
    const e = raw as Record<string, unknown>;
    if (e.isDeleted) return;
    const id = ids.get(String(e.id)) ?? makeId().replace(SAFE_ID, '');
    const x = num(e.x);
    const y = num(e.y);
    const w = Math.abs(num(e.width));
    const h = Math.abs(num(e.height));
    const stroke = color(e.strokeColor);
    const fill = color(e.backgroundColor);
    const base = { id, order: keys[index]!, x, y, w, h, ...(num(e.angle) ? { rotation: num(e.angle) } : {}) };
    const frameId = typeof e.frameId === 'string' ? ids.get(e.frameId) : undefined;
    const parent = frameId ? { parent: frameId } : {};
    if (!addExcalidraw(e, { base, parent, x, y, w, h, stroke, fill }, ids, out)) skipped++;
  });
  // Frames first, so their contents can sit in them.
  out.sort((a, b) => (a.type === 'frame' ? 0 : 1) - (b.type === 'frame' ? 0 : 1));
  return { fragment: fragmentOf(out), skipped };
}

/** The cell delimiter of CSV or plain text: tab, else semicolon when the first line has those and no comma, else comma. */
function delimiterOf(text: string): string {
  if (text.includes('\t')) return '\t';
  const firstLine = text.split('\n')[0]!;
  return firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
}

/** Reads CSV or plain text one character at a time into rows of cells. */
class CellReader {
  readonly rows: string[][] = [];
  private row: string[] = [];
  private cell = '';
  private quoted = false;

  constructor(
    private readonly text: string,
    private readonly delimiter: string,
  ) {}

  /** Reads the character at `i` (two for an escaped quote or a CRLF); returns the index to read next. */
  read(i: number): number {
    const ch = this.text[i]!;
    if (this.quoted) return this.readQuoted(ch, i);
    if (ch === '"' && this.cell === '') this.quoted = true;
    else if (ch === this.delimiter) this.endCell();
    else if (ch === '\n' || ch === '\r') {
      this.endRow();
      if (ch === '\r' && this.text[i + 1] === '\n') return i + 2;
    } else this.cell += ch;
    return i + 1;
  }

  private readQuoted(ch: string, i: number): number {
    if (ch !== '"') {
      this.cell += ch;
      return i + 1;
    }
    if (this.text[i + 1] === '"') {
      this.cell += '"';
      return i + 2;
    }
    this.quoted = false;
    return i + 1;
  }

  private endCell(): void {
    this.row.push(this.cell);
    this.cell = '';
  }

  private endRow(): void {
    this.endCell();
    this.rows.push(this.row);
    this.row = [];
  }

  /** The rows, with the last one when the text does not end in a line break. */
  finish(): string[][] {
    if (this.cell !== '' || this.row.length) this.endRow();
    return this.rows;
  }
}

/** Splits CSV or plain text into cells: one row per line, cells by comma, semicolon or tab. */
export function parseCells(text: string): string[][] {
  const reader = new CellReader(text, delimiterOf(text));
  let i = 0;
  while (i < text.length) i = reader.read(i);
  return reader
    .finish()
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

/** Text lines (or CSV cells) as a grid of sticky notes; one column per CSV column. */
export function stickiesFromText(text: string, makeId: () => string, options: { columns?: number; color?: string } = {}): Fragment {
  const rows = parseCells(text);
  const cells = rows.length && rows.every((r) => r.length === 1) ? rows.map((r) => [r[0]!]) : rows;
  const gap = 24;
  const out: BoardElement[] = [];
  const flat = cells.length && cells[0]!.length === 1;
  const perRow = flat ? (options.columns ?? Math.min(8, Math.ceil(Math.sqrt(cells.length)))) : 0;
  const total = flat ? cells.length : cells.reduce((n, r) => n + r.length, 0);
  const keys = keysBetween(null, null, Math.min(total, MAX_IMPORT) || 1);
  let n = 0;
  cells.forEach((row, r) => {
    row.forEach((value, c) => {
      if (!value || n >= MAX_IMPORT) return;
      const col = flat ? n % perRow : c;
      const line = flat ? Math.floor(n / perRow) : r;
      out.push({
        id: makeId(),
        type: 'sticky',
        order: keys[n]!,
        x: col * (STICKY_SIZE + gap),
        y: line * (STICKY_SIZE + gap),
        w: STICKY_SIZE,
        h: STICKY_SIZE,
        fill: options.color ?? (flat ? STICKY_COLORS[0] : STICKY_COLORS[c % STICKY_COLORS.length]!),
        text: plain(value.slice(0, 2000)),
        fontSize: 22,
        textAlign: 'center',
        vAlign: 'middle',
        autoFit: true,
      });
      n++;
    });
  });
  return fragmentOf(out);
}

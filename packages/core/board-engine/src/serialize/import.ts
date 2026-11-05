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
    switch (e.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        const shape: ShapeKind = e.type === 'rectangle' ? (e.roundness ? 'rounded' : 'rectangle') : e.type;
        out.push({
          ...base,
          ...parent,
          type: 'shape',
          shape,
          fill: fill ?? 'transparent',
          stroke: stroke ?? '#1e1e1e',
          strokeWidth: Math.max(1, num(e.strokeWidth, 2)),
          ...(e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted' ? { strokeStyle: e.strokeStyle } : {}),
        });
        return;
      }
      case 'text': {
        const text = str(e.text) ?? '';
        if (typeof e.containerId === 'string') {
          // Text bound inside a shape becomes the shape's text.
          const container = out.find((o) => o.id === ids.get(String(e.containerId)));
          if (container && container.type === 'shape') {
            container.text = plain(text);
            container.fontSize = num(e.fontSize, 16);
            return;
          }
        }
        out.push({
          ...base,
          ...parent,
          w: Math.max(w, 20),
          h: Math.max(h, 20),
          type: 'text',
          text: plain(text),
          fontSize: num(e.fontSize, 20),
          textColor: stroke ?? '#1e1e1e',
          textAlign: e.textAlign === 'center' || e.textAlign === 'right' ? e.textAlign : 'left',
        });
        return;
      }
      case 'arrow':
      case 'line': {
        const points = Array.isArray(e.points) ? (e.points as unknown[]).filter(Array.isArray) as number[][] : [];
        const first = points[0] ?? [0, 0];
        const last = points[points.length - 1] ?? [w, h];
        const bind = (b: unknown) => {
          const id2 = (b as { elementId?: unknown } | null)?.elementId;
          return typeof id2 === 'string' && ids.has(id2) ? { el: ids.get(id2)!, side: 'auto' as const } : {};
        };
        const cap = (v: unknown): Cap => (v === 'arrow' || v === 'triangle' ? 'arrow' : v === 'dot' || v === 'circle' ? 'circle' : v === 'bar' ? 'bar' : 'none');
        out.push({
          ...base,
          ...parent,
          type: 'connector',
          start: { x: x + num(first[0]), y: y + num(first[1]), ...bind(e.startBinding) },
          end: { x: x + num(last[0]), y: y + num(last[1]), ...bind(e.endBinding) },
          route: e.elbowed ? 'elbow' : points.length > 2 ? 'curved' : 'straight',
          startCap: cap(e.startArrowhead),
          endCap: e.type === 'arrow' ? cap(e.endArrowhead ?? 'arrow') : 'none',
          stroke: stroke ?? '#1e1e1e',
          strokeWidth: Math.max(1, num(e.strokeWidth, 2)),
        });
        return;
      }
      case 'freedraw': {
        const points = Array.isArray(e.points) ? (e.points as unknown[]).filter(Array.isArray) as number[][] : [];
        const pressures = Array.isArray(e.pressures) ? (e.pressures as number[]) : [];
        const flat: number[] = [];
        points.slice(0, 30_000).forEach((p, i) => flat.push(num(p[0]), num(p[1]), num(pressures[i], 0.5)));
        out.push({ ...base, ...parent, type: 'pen', points: flat, stroke: stroke ?? '#1e1e1e', strokeWidth: Math.max(1, num(e.strokeWidth, 2)) });
        return;
      }
      case 'frame':
      case 'magicframe':
        out.push({ ...base, type: 'frame', name: str(e.name) ?? 'Frame', fill: '#ffffff' });
        return;
      default:
        skipped++;
    }
  });
  // Frames first, so their contents can sit in them.
  out.sort((a, b) => (a.type === 'frame' ? 0 : 1) - (b.type === 'frame' ? 0 : 1));
  return { fragment: fragmentOf(out), skipped };
}

/** Splits CSV or plain text into cells: one row per line, cells by comma, semicolon or tab. */
export function parseCells(text: string): string[][] {
  const rows: string[][] = [];
  const delimiter = text.includes('\t') ? '\t' : text.split('\n')[0]!.includes(';') && !text.split('\n')[0]!.includes(',') ? ';' : ',';
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
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

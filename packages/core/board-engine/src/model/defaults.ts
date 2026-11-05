/**
 * Default looks and factories for new elements. The editor, templates,
 * converters and agent tools all make elements through these, so a sticky
 * looks the same whoever made it.
 */

import { keyBetween } from './order';
import { plain } from './text';
import type { BoardElement, RichText, ShapeKind } from './types';

export const DEFAULT_FONT = 'Inter';
export const DEFAULT_FONT_SIZE = 16;
export const STICKY_SIZE = 200;
export const DEFAULT_STROKE = '#1f2937';
export const DEFAULT_TEXT = '#1f2937';
export const SELECTION_COLOR = '#2563eb';

/** Sticky note colours, in palette order. */
export const STICKY_COLORS = [
  '#fff9b1', // yellow
  '#f5d128', // gold
  '#d0e17a', // lime
  '#93d275', // green
  '#67c6c0', // teal
  '#a6ccf5', // light blue
  '#6cd8fa', // cyan
  '#c9df56', // olive
  '#ffcee0', // pink
  '#ea94bb', // rose
  '#ff9d48', // orange
  '#be88c7', // violet
  '#f16c7f', // red
  '#e6e6e6', // grey
  '#ffffff', // white
] as const;

/** Fill and stroke colours offered for shapes, text and lines. */
export const PALETTE = [
  '#1f2937', '#6b7280', '#ffffff', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
] as const;

export const SHAPE_FILLS = ['#ffffff', '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#cffafe', '#dbeafe', '#ede9fe', '#fce7f3', '#f3f4f6'] as const;

let counter = 0;

/** A new element id: short, unique enough across replicas (time + randomness + a counter). */
export function newId(prefix = 'e'): string {
  counter = (counter + 1) % 1296;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `${prefix}${time}${rand}${counter.toString(36).padStart(2, '0')}`;
}

export interface Placement {
  parent?: string | null;
  /** Order key; defaults to a key above `after` (or the very first key). */
  order?: string;
  after?: string | null;
  createdBy?: string;
  now?: number;
}

function base(type: BoardElement['type'], x: number, y: number, w: number, h: number, at: Placement, id?: string): BoardElement {
  const el: BoardElement = {
    id: id ?? newId(),
    type,
    order: at.order ?? keyBetween(at.after ?? null, null),
    x,
    y,
    w,
    h,
  };
  if (at.parent) el.parent = at.parent;
  if (at.createdBy) el.createdBy = at.createdBy;
  if (at.now !== undefined) el.createdAt = at.now;
  return el;
}

export function makeSticky(x: number, y: number, at: Placement = {}, options: { color?: string; text?: string | RichText; size?: number; id?: string } = {}): BoardElement {
  const size = options.size ?? STICKY_SIZE;
  const text = typeof options.text === 'string' ? plain(options.text) : (options.text ?? plain());
  return {
    ...base('sticky', x, y, size, size, at, options.id),
    fill: options.color ?? STICKY_COLORS[0],
    text,
    fontSize: 22,
    textAlign: 'center',
    vAlign: 'middle',
    autoFit: true,
  };
}

export function makeShape(
  shape: ShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  at: Placement = {},
  options: { fill?: string; stroke?: string; text?: string | RichText; id?: string } = {},
): BoardElement {
  const text = typeof options.text === 'string' ? plain(options.text) : options.text;
  return {
    ...base('shape', x, y, w, h, at, options.id),
    shape,
    fill: options.fill ?? '#ffffff',
    stroke: options.stroke ?? DEFAULT_STROKE,
    strokeWidth: 2,
    fontSize: DEFAULT_FONT_SIZE,
    textAlign: 'center',
    vAlign: 'middle',
    ...(text ? { text } : {}),
  };
}

export function makeText(x: number, y: number, text: string | RichText, at: Placement = {}, options: { fontSize?: number; w?: number; id?: string } = {}): BoardElement {
  const fontSize = options.fontSize ?? 24;
  return {
    ...base('text', x, y, options.w ?? 320, Math.ceil(fontSize * 1.4), at, options.id),
    text: typeof text === 'string' ? plain(text) : text,
    fontSize,
    textAlign: 'left',
    vAlign: 'top',
  };
}

export function makeFrame(x: number, y: number, w: number, h: number, name: string, at: Placement = {}, options: { fill?: string; id?: string } = {}): BoardElement {
  return { ...base('frame', x, y, w, h, at, options.id), name, fill: options.fill ?? '#ffffff' };
}

export function makeConnector(
  start: BoardElement['start'] & object,
  end: BoardElement['end'] & object,
  at: Placement = {},
  options: { route?: BoardElement['route']; endCap?: BoardElement['endCap']; startCap?: BoardElement['startCap']; stroke?: string; id?: string } = {},
): BoardElement {
  return {
    ...base('connector', Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y), at, options.id),
    start,
    end,
    route: options.route ?? 'elbow',
    startCap: options.startCap ?? 'none',
    endCap: options.endCap ?? 'arrow',
    stroke: options.stroke ?? DEFAULT_STROKE,
    strokeWidth: 2,
  };
}

export function makeCard(x: number, y: number, title: string, at: Placement = {}, options: { description?: string; id?: string } = {}): BoardElement {
  return {
    ...base('card', x, y, 300, 140, at, options.id),
    text: plain(title),
    fill: '#ffffff',
    stroke: '#3b82f6',
    fontSize: 16,
    textAlign: 'left',
    vAlign: 'top',
    ...(options.description ? { description: options.description } : {}),
  };
}

/** The topmost order key on a board's top level (a new element goes above it). */
export function nextOrder(after: string | null): string {
  return keyBetween(after, null);
}

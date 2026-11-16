/**
 * Dashboard tile layout. The API stores `{ x, y, w, h }` on a 24-column grid;
 * the page shows tiles in reading order and edits them by order and size, so a
 * change is "move earlier", "wider", "taller" and the whole layout is packed
 * again (left to right, a new row when a tile does not fit). That needs no
 * drag library and works on a phone.
 */

export const GRID_COLUMNS = 24;
export const ROW_UNIT_PX = 40;

export interface TileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutItem {
  id: string;
  layout: TileLayout;
}

export const TILE_WIDTHS = [6, 8, 12, 16, 24] as const;
export const MIN_TILE_HEIGHT = 5;
export const MAX_TILE_HEIGHT = 20;
const HEIGHT_STEP = 3;

/** Reading order: top to bottom, then left to right. */
export function orderItems<T extends LayoutItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}

/** Lays items out in the given order: rows of tiles that fit the grid, each row as tall as its tallest tile. */
export function packLayout(items: readonly { id: string; w: number; h: number }[]): LayoutItem[] {
  const placed: LayoutItem[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const item of items) {
    const w = Math.min(GRID_COLUMNS, Math.max(1, item.w));
    const h = Math.min(24, Math.max(1, item.h));
    if (x + w > GRID_COLUMNS) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    placed.push({ id: item.id, layout: { x, y, w, h } });
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

/** The ordered items packed again: what a freshly added tile (placed at y 1000) needs to join the grid. */
export function normalizeLayout<T extends LayoutItem>(items: readonly T[]): LayoutItem[] {
  return packLayout(orderItems(items).map((item) => ({ id: item.id, ...item.layout })));
}

export function moveItem<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** The next wider (`1`) or narrower (`-1`) of the standard widths, or the same one at the ends. */
export function stepWidth(width: number, direction: -1 | 1): number {
  const sorted = [...TILE_WIDTHS];
  if (direction === 1) return sorted.find((w) => w > width) ?? width;
  return [...sorted].reverse().find((w) => w < width) ?? width;
}

export function stepHeight(height: number, direction: -1 | 1): number {
  return Math.min(MAX_TILE_HEIGHT, Math.max(MIN_TILE_HEIGHT, height + direction * HEIGHT_STEP));
}

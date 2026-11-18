import { describe, expect, it } from 'vitest';
import { GRID_COLUMNS, MAX_TILE_HEIGHT, MIN_TILE_HEIGHT, moveItem, normalizeLayout, orderItems, packLayout, stepHeight, stepWidth } from './dashboard-layout';

describe('packLayout', () => {
  it('fills a row left to right, then starts a new one below the tallest tile', () => {
    const packed = packLayout([
      { id: 'a', w: 12, h: 8 },
      { id: 'b', w: 8, h: 10 },
      { id: 'c', w: 8, h: 6 },
    ]);
    expect(packed.map((p) => p.layout)).toEqual([
      { x: 0, y: 0, w: 12, h: 8 },
      { x: 12, y: 0, w: 8, h: 10 },
      { x: 0, y: 10, w: 8, h: 6 },
    ]);
  });

  it('never makes a tile wider than the grid', () => {
    expect(packLayout([{ id: 'a', w: 99, h: 5 }])[0]?.layout.w).toBe(GRID_COLUMNS);
  });
});

describe('normalizeLayout', () => {
  it('puts a tile added at y 1000 last and closes the gaps', () => {
    const items = [
      { id: 'new', layout: { x: 0, y: 1000, w: 12, h: 8 } },
      { id: 'old', layout: { x: 0, y: 4, w: 12, h: 8 } },
    ];
    expect(orderItems(items).map((i) => i.id)).toEqual(['old', 'new']);
    expect(normalizeLayout(items)).toEqual([
      { id: 'old', layout: { x: 0, y: 0, w: 12, h: 8 } },
      { id: 'new', layout: { x: 12, y: 0, w: 12, h: 8 } },
    ]);
  });
});

describe('editing helpers', () => {
  it('moves an item by one and stays put at the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('steps through the standard widths', () => {
    expect(stepWidth(12, 1)).toBe(16);
    expect(stepWidth(12, -1)).toBe(8);
    expect(stepWidth(24, 1)).toBe(24);
    expect(stepWidth(6, -1)).toBe(6);
  });

  it('keeps the height within bounds', () => {
    expect(stepHeight(8, 1)).toBeGreaterThan(8);
    expect(stepHeight(MIN_TILE_HEIGHT, -1)).toBe(MIN_TILE_HEIGHT);
    expect(stepHeight(MAX_TILE_HEIGHT, 1)).toBe(MAX_TILE_HEIGHT);
  });
});

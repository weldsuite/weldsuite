import { describe, expect, it } from 'vitest';
import {
  idsInMarquee,
  rectFromPoints,
  resizeRect,
  snapMove,
  snapResize,
  unionRect,
  type SnapContext,
} from './snapping';

const ctx = (over: Partial<SnapContext> = {}): SnapContext => ({
  page: { width: 600, height: 800 },
  margins: { top: 48, bottom: 56 },
  others: [],
  threshold: 4,
  ...over,
});

describe('snapMove', () => {
  it('snaps the top-left corner to the 4pt grid when nothing is near', () => {
    const { rect, guides } = snapMove({ x: 101, y: 203, w: 50, h: 30 }, ctx());
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(204);
    expect(guides).toEqual([]);
  });

  it('snaps the left edge to the page margin and reports a guide', () => {
    const { rect, guides } = snapMove({ x: 50, y: 100, w: 80, h: 20 }, ctx());
    expect(rect.x).toBe(48);
    expect(guides.some((g) => g.axis === 'x' && g.pos === 48)).toBe(true);
  });

  it('snaps the centre to the page centre', () => {
    const { rect } = snapMove({ x: 262, y: 100, w: 80, h: 20 }, ctx());
    expect(rect.x + rect.w / 2).toBe(300);
  });

  it('snaps to the edges of another block and the guide spans both', () => {
    const other = { x: 200, y: 400, w: 100, h: 50 };
    const { rect, guides } = snapMove({ x: 202, y: 300, w: 60, h: 30 }, ctx({ others: [other] }));
    expect(rect.x).toBe(200);
    const guide = guides.find((g) => g.axis === 'x' && g.pos === 200);
    expect(guide).toBeDefined();
    expect(guide!.start).toBeLessThanOrEqual(300);
    expect(guide!.end).toBeGreaterThanOrEqual(450);
  });

  it('snaps the bottom edge to the bottom margin', () => {
    const { rect } = snapMove({ x: 100, y: 700, w: 50, h: 42 }, ctx());
    expect(rect.y + rect.h).toBe(800 - 56);
  });

  it('does nothing when snapping is disabled (Alt)', () => {
    const start = { x: 50.3, y: 100.7, w: 80, h: 20 };
    const { rect, guides } = snapMove(start, ctx({ disabled: true }));
    expect(rect).toEqual(start);
    expect(guides).toEqual([]);
  });
});

describe('resizeRect', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };

  it('moves the south-east corner', () => {
    expect(resizeRect(start, 'se', 20, 10)).toEqual({ x: 100, y: 100, w: 220, h: 110 });
  });

  it('moves the north-west corner and keeps the opposite corner fixed', () => {
    expect(resizeRect(start, 'nw', 20, 10)).toEqual({ x: 120, y: 110, w: 180, h: 90 });
  });

  it('never goes below the minimum size and pins the far edge', () => {
    const r = resizeRect(start, 'w', 500, 0);
    expect(r.w).toBe(4);
    expect(r.x + r.w).toBe(300);
    const s = resizeRect(start, 'n', 0, 500);
    expect(s.h).toBe(4);
    expect(s.y + s.h).toBe(200);
  });

  it('honours a custom minimum', () => {
    expect(resizeRect(start, 's', 0, -500, { minH: 1 }).h).toBe(1);
  });

  it('keeps the aspect ratio on a corner with aspect', () => {
    const r = resizeRect(start, 'se', 100, 0, { aspect: true });
    expect(r.w / r.h).toBeCloseTo(2);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
  });
});

describe('snapResize', () => {
  it('snaps the dragged right edge to the page margin', () => {
    const { rect } = snapResize({ x: 100, y: 100, w: 449, h: 40 }, 'e', ctx());
    expect(rect.x + rect.w).toBe(552);
  });

  it('snaps only the dragged edges to the grid', () => {
    const { rect } = snapResize({ x: 101, y: 103, w: 51, h: 41 }, 'se', ctx());
    expect(rect.x).toBe(101);
    expect(rect.y).toBe(103);
    expect((rect.x + rect.w) % 4).toBe(0);
    expect((rect.y + rect.h) % 4).toBe(0);
  });

  it('keeps the minimum size', () => {
    const { rect } = snapResize({ x: 100, y: 100, w: 5, h: 5 }, 'se', ctx({ threshold: 0 }));
    expect(rect.w).toBeGreaterThanOrEqual(4);
    expect(rect.h).toBeGreaterThanOrEqual(4);
  });
});

describe('marquee helpers', () => {
  it('builds a rectangle from any two corners', () => {
    expect(rectFromPoints({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 40 });
  });

  it('selects the blocks it touches', () => {
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 100, y: 100, w: 10, h: 10 },
      { id: 'c', x: 5, y: 5, w: 50, h: 50 },
    ];
    expect(idsInMarquee(blocks, { x: 8, y: 8, w: 4, h: 4 })).toEqual(['a', 'c']);
    expect(idsInMarquee(blocks, { x: 200, y: 200, w: 4, h: 4 })).toEqual([]);
  });

  it('unions rectangles', () => {
    expect(unionRect([{ x: 10, y: 10, w: 10, h: 10 }, { x: 50, y: 40, w: 5, h: 5 }])).toEqual({ x: 10, y: 10, w: 45, h: 35 });
    expect(unionRect([])).toBeNull();
  });
});

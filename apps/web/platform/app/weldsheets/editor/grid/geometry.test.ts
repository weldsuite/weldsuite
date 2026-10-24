import { describe, expect, it } from 'vitest';
import { Sheet } from '@weldsuite/sheets-engine';
import {
  COL_HEADER_HEIGHT,
  computeLayout,
  hitTest,
  MAX_SCROLL_SIZE,
  rangeRect,
  scrollIntoView,
  toLogicalScroll,
  toPhysicalScroll,
} from './geometry';

function sheet() {
  const s = new Sheet('s1', 'Sheet1');
  s.rowCount = 1000;
  s.colCount = 26;
  return s;
}

describe('grid geometry', () => {
  it('lists the visible rows and columns after scrolling', () => {
    const s = sheet();
    const layout = computeLayout(s, 800, 400, 250, 105);
    expect(layout.cols[0]!.index).toBe(2);
    expect(layout.rows[0]!.index).toBe(5);
    expect(layout.rows[0]!.start).toBe(COL_HEADER_HEIGHT);
    expect(layout.rows.at(-1)!.start).toBeLessThan(400);
  });

  it('keeps frozen rows in place and skips hidden ones', () => {
    const s = sheet();
    s.freeze = { rows: 2, cols: 1 };
    s.rows.setHidden(3, true);
    const layout = computeLayout(s, 800, 400, 0, 0);
    expect(layout.rows.slice(0, 3).map((r) => r.index)).toEqual([0, 1, 2]);
    expect(layout.rows.some((r) => r.index === 3)).toBe(false);
    const scrolled = computeLayout(s, 800, 400, 0, 210);
    expect(scrolled.rows.slice(0, 2).map((r) => r.index)).toEqual([0, 1]);
    expect(scrolled.rows[2]!.index).toBeGreaterThan(5);
  });

  it('hit-tests cells, headers and resize borders', () => {
    const s = sheet();
    const layout = computeLayout(s, 800, 400, 0, 0);
    const x = layout.rowHeaderWidth + 150;
    expect(hitTest(layout, s, x, COL_HEADER_HEIGHT + 30)).toMatchObject({ area: 'cell', row: 1, col: 1 });
    expect(hitTest(layout, s, x, 10)).toMatchObject({ area: 'colHeader', col: 1 });
    expect(hitTest(layout, s, layout.rowHeaderWidth + 99, 10).resize).toEqual({ axis: 'col', index: 0 });
    expect(hitTest(layout, s, 5, 5).area).toBe('corner');
  });

  it('computes range rectangles and scrolls cells into view', () => {
    const s = sheet();
    const layout = computeLayout(s, 800, 400, 0, 0);
    expect(rangeRect(layout, s, { r1: 1, c1: 1, r2: 2, c2: 2 })).toEqual({
      x: layout.rowHeaderWidth + 100,
      y: COL_HEADER_HEIGHT + 21,
      w: 200,
      h: 42,
    });
    expect(scrollIntoView(layout, s, 0, 0)).toBeNull();
    expect(scrollIntoView(layout, s, 100, 0)?.scrollY).toBeGreaterThan(0);
  });

  it('scales scroll offsets past the browser size limit', () => {
    const content = 22_000_000;
    const viewport = 500;
    const physical = toPhysicalScroll(11_000_000, content, viewport);
    expect(physical).toBeLessThan(MAX_SCROLL_SIZE);
    expect(toLogicalScroll(physical, content, viewport)).toBeCloseTo(11_000_000, 0);
    expect(toPhysicalScroll(300, 5000, 500)).toBe(300);
  });
});

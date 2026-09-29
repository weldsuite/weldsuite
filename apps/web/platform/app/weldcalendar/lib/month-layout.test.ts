import { describe, it, expect } from 'vitest';
import {
  MONTH_CELL_CHROME,
  MONTH_CHIP_GAP,
  MONTH_CHIP_HEIGHT,
  monthCellCapacity,
  splitMonthCellEvents,
} from './month-layout';

describe('monthCellCapacity', () => {
  it('is zero when the row is too short for even one chip', () => {
    expect(monthCellCapacity(0)).toBe(0);
    expect(monthCellCapacity(MONTH_CELL_CHROME)).toBe(0);
    expect(monthCellCapacity(MONTH_CELL_CHROME + MONTH_CHIP_HEIGHT - 1)).toBe(0);
    expect(monthCellCapacity(Number.NaN)).toBe(0);
  });

  it('fits exactly n chips (with gaps) once the row is tall enough', () => {
    const rowFor = (n: number) =>
      MONTH_CELL_CHROME + n * MONTH_CHIP_HEIGHT + (n - 1) * MONTH_CHIP_GAP;
    for (const n of [1, 2, 3, 5]) {
      expect(monthCellCapacity(rowFor(n))).toBe(n);
      expect(monthCellCapacity(rowFor(n) - 1)).toBe(n - 1);
    }
  });

  it('matches the QA scenario: six week rows in a 755px grid', () => {
    // 755px / 6 rows ~ 125px per row -> 4 chips, never a row of 153px+.
    expect(monthCellCapacity(755 / 6)).toBe(4);
  });
});

describe('splitMonthCellEvents', () => {
  it('shows every event when they all fit', () => {
    expect(splitMonthCellEvents(0, 4)).toEqual({ visible: 0, hidden: 0 });
    expect(splitMonthCellEvents(3, 4)).toEqual({ visible: 3, hidden: 0 });
    expect(splitMonthCellEvents(4, 4)).toEqual({ visible: 4, hidden: 0 });
  });

  it('gives up one chip slot to the "+N more" line when events overflow', () => {
    // 4 slots, 5 events: 3 chips + "+2 more" (which itself takes the 4th slot).
    expect(splitMonthCellEvents(5, 4)).toEqual({ visible: 3, hidden: 2 });
    expect(splitMonthCellEvents(10, 4)).toEqual({ visible: 3, hidden: 7 });
  });

  it('never renders more rows than the capacity', () => {
    for (let capacity = 0; capacity <= 8; capacity++) {
      for (let total = 0; total <= 12; total++) {
        const { visible, hidden } = splitMonthCellEvents(total, capacity);
        const rows = visible + (hidden > 0 ? 1 : 0);
        expect(visible + hidden).toBe(total);
        // With no room at all the "+N more" line is still shown so the day
        // stays reachable, so allow that single-row floor.
        expect(rows).toBeLessThanOrEqual(Math.max(capacity, 1));
      }
    }
  });

  it('collapses everything into "+N more" when only one slot fits', () => {
    expect(splitMonthCellEvents(3, 1)).toEqual({ visible: 0, hidden: 3 });
    expect(splitMonthCellEvents(3, 0)).toEqual({ visible: 0, hidden: 3 });
    // A single event still fits in a single slot.
    expect(splitMonthCellEvents(1, 1)).toEqual({ visible: 1, hidden: 0 });
  });

  it('holds back reserved slots for the preview chip', () => {
    // Today has 3 events in a 4-slot cell; the preview takes a slot, so one
    // chip becomes "+N more" instead of being clipped.
    expect(splitMonthCellEvents(3, 4, 1)).toEqual({ visible: 3, hidden: 0 });
    expect(splitMonthCellEvents(4, 4, 1)).toEqual({ visible: 2, hidden: 2 });
  });
});

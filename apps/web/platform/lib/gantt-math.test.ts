import { describe, expect, it } from 'vitest';
import { differenceInDays } from 'date-fns';
import {
  getDateAtOffset,
  getDragShiftDays,
  getOffset,
  getWidth,
  type GanttMathContext,
} from '@weldsuite/ui/lib/gantt-math';

// The timeline starts on 1 January of the first rendered year.
const TIMELINE_START = new Date(2025, 0, 1);

const monthly: GanttMathContext = { range: 'monthly', columnWidth: 150, zoom: 100 };
const quarterly: GanttMathContext = { range: 'quarterly', columnWidth: 100, zoom: 200 };
const weekly: GanttMathContext = { range: 'weekly', columnWidth: 50, zoom: 150 };
const daily: GanttMathContext = { range: 'daily', columnWidth: 50, zoom: 320 };

const ALL: [string, GanttMathContext][] = [
  ['monthly', monthly],
  ['quarterly', quarterly],
  ['weekly', weekly],
  ['daily', daily],
];

describe('gantt-math getDateAtOffset', () => {
  it.each(ALL)('is the inverse of getOffset (%s)', (_name, ctx) => {
    for (const date of [
      new Date(2026, 0, 1),
      new Date(2026, 1, 28),
      new Date(2026, 9, 8),
      new Date(2026, 9, 15),
      new Date(2026, 11, 31),
      new Date(2027, 2, 31),
    ]) {
      const px = getOffset(date, TIMELINE_START, ctx);
      const back = getDateAtOffset(px, TIMELINE_START, ctx);
      expect(differenceInDays(back, date)).toBe(0);
    }
  });

  it('always returns local midnight (no stray time of day)', () => {
    const date = getDateAtOffset(1234.56, TIMELINE_START, monthly);
    expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });
});

describe('gantt-math getDragShiftDays', () => {
  it('moves by about the dragged distance, not ~9x too far (monthly, 100% zoom)', () => {
    // QA repro: bar starting Oct 8 2026, dragged ~55px right with ~150px per
    // month. That is about 11 days, not ~115.
    const days = getDragShiftDays(55, new Date(2026, 9, 8), TIMELINE_START, monthly);
    expect(days).toBeGreaterThanOrEqual(10);
    expect(days).toBeLessThanOrEqual(12);
  });

  it('is zero for no movement and symmetric for left/right drags', () => {
    const start = new Date(2026, 9, 8);
    expect(getDragShiftDays(0, start, TIMELINE_START, monthly)).toBe(0);
    expect(getDragShiftDays(-55, start, TIMELINE_START, monthly)).toBe(
      -getDragShiftDays(55, start, TIMELINE_START, monthly)
    );
  });

  it('shifts a whole number of days', () => {
    const days = getDragShiftDays(37.3, new Date(2026, 5, 3), TIMELINE_START, monthly);
    expect(Number.isInteger(days)).toBe(true);
  });

  it('crosses month boundaries without jumping a column', () => {
    // 150px is exactly one month column: Oct 8 -> about Nov 8.
    const days = getDragShiftDays(150, new Date(2026, 9, 8), TIMELINE_START, monthly);
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThanOrEqual(32);
  });

  it('scales with zoom', () => {
    const zoomed = { ...monthly, zoom: 200 };
    const normal = getDragShiftDays(100, new Date(2026, 9, 8), TIMELINE_START, monthly);
    const twice = getDragShiftDays(100, new Date(2026, 9, 8), TIMELINE_START, zoomed);
    expect(twice).toBeLessThan(normal);
    expect(Math.abs(normal - 2 * twice)).toBeLessThanOrEqual(1);
  });

  it('daily: one column is one day', () => {
    // 50 * 3.2 = 160px per day.
    expect(getDragShiftDays(320, new Date(2026, 9, 8), TIMELINE_START, daily)).toBe(2);
    expect(getDragShiftDays(-160, new Date(2026, 9, 8), TIMELINE_START, daily)).toBe(-1);
  });

  it('weekly: one column is seven days', () => {
    // 50 * 1.5 = 75px per week.
    expect(getDragShiftDays(75, new Date(2026, 9, 8), TIMELINE_START, weekly)).toBe(7);
    expect(getDragShiftDays(-150, new Date(2026, 9, 8), TIMELINE_START, weekly)).toBe(-14);
  });
});

describe('gantt-math weekly bars', () => {
  it('width is proportional to the number of days', () => {
    const oneWeek = getWidth(new Date(2026, 9, 5), new Date(2026, 9, 12), weekly);
    expect(oneWeek).toBeCloseTo(75);
  });

  it('offset advances 1/7 of a column per day within a week', () => {
    const monday = getOffset(new Date(2026, 9, 5), TIMELINE_START, weekly);
    const thursday = getOffset(new Date(2026, 9, 8), TIMELINE_START, weekly);
    expect(thursday - monday).toBeCloseTo((75 * 3) / 7);
  });
});

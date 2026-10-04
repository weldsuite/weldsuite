import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/use-settings-queries', () => ({ useUserPreferences: () => ({ data: undefined }) }));

import { getCalendarDateRange, getMobileMonthListRange, type CalendarView } from './date-range';

const range = (date: Date, view: CalendarView) => {
  const { start, end } = getCalendarDateRange(date, view);
  return { start: new Date(start), end: new Date(end) };
};

/** Local clock fields of a date: [y, m, d, h, min, s, ms]. */
const fields = (d: Date) => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];

const wed = new Date(2026, 9, 7, 15, 20); // Wed 7 Oct 2026

describe('getCalendarDateRange', () => {
  it('year: runs from 1 Jan 00:00 to the very end of 31 Dec', () => {
    const { start, end } = range(wed, 'year');
    expect(fields(start)).toEqual([2026, 0, 1, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 11, 31, 23, 59, 59, 999]);
  });

  it('day: whole day', () => {
    const { start, end } = range(wed, 'day');
    expect(fields(start)).toEqual([2026, 9, 7, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 9, 7, 23, 59, 59, 999]);
  });

  it('week: Monday 00:00 to Sunday end', () => {
    const { start, end } = range(wed, 'week');
    expect(fields(start)).toEqual([2026, 9, 5, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 9, 11, 23, 59, 59, 999]);
  });

  it('4day: four whole days starting at the date', () => {
    const { start, end } = range(wed, '4day');
    expect(fields(start)).toEqual([2026, 9, 7, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 9, 10, 23, 59, 59, 999]);
  });

  it('month: whole weeks around the month, ending at the end of the last day', () => {
    const { start, end } = range(wed, 'month');
    // 1 Oct 2026 is a Thursday, 31 Oct a Saturday.
    expect(fields(start)).toEqual([2026, 8, 28, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 10, 1, 23, 59, 59, 999]);
  });

  it('schedule: 60 days from the start of the selected day, inclusive of the last day', () => {
    const { start, end } = range(wed, 'schedule');
    expect(fields(start)).toEqual([2026, 9, 7, 0, 0, 0, 0]);
    expect(fields(end)).toEqual([2026, 11, 5, 23, 59, 59, 999]);
  });

  it('every range ends at the end of a day', () => {
    for (const view of ['month', 'week', '4day', 'day', 'year', 'schedule'] as const) {
      const { end } = range(wed, view);
      expect(fields(end).slice(3)).toEqual([23, 59, 59, 999]);
    }
  });
});

describe('getMobileMonthListRange', () => {
  it('covers every month the mobile list renders: 12 back to the end of 24 ahead', () => {
    const { start, end } = getMobileMonthListRange(wed);
    expect(fields(new Date(start))).toEqual([2025, 9, 1, 0, 0, 0, 0]);
    expect(fields(new Date(end))).toEqual([2028, 9, 31, 23, 59, 59, 999]);
  });

  it('is stable within a month, so the query key does not change from day to day', () => {
    expect(getMobileMonthListRange(new Date(2026, 9, 1))).toEqual(getMobileMonthListRange(new Date(2026, 9, 31, 23, 59)));
  });
});

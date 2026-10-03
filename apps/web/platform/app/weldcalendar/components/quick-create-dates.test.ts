import { describe, it, expect } from 'vitest';
import {
  defaultQuickCreateRange,
  defaultRangeForDay,
  normalizeQuickCreateRange,
  resolveQuickCreateTimes,
  resolveTaskSlot,
  shiftEndDate,
  type QuickCreateRange,
} from './quick-create-dates';

describe('defaultQuickCreateRange', () => {
  it('starts at the next full hour and lasts an hour', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 14, 20))).toEqual({
      startDate: '2026-10-02',
      startTime: '15:00',
      endDate: '2026-10-02',
      endTime: '16:00',
    });
  });

  it('rolls over to tomorrow late in the evening instead of a time that already passed', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 23, 25))).toEqual({
      startDate: '2026-10-03',
      startTime: '00:00',
      endDate: '2026-10-03',
      endTime: '01:00',
    });
  });

  it('ends after midnight on the next day for a late start', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 22, 40))).toEqual({
      startDate: '2026-10-02',
      startTime: '23:00',
      endDate: '2026-10-03',
      endTime: '00:00',
    });
  });

  it('uses the given start and end', () => {
    const range = defaultQuickCreateRange(new Date(2026, 9, 5, 10, 0), new Date(2026, 9, 5, 11, 30));
    expect(range).toEqual({ startDate: '2026-10-05', startTime: '10:00', endDate: '2026-10-05', endTime: '11:30' });
  });

  it('makes a given start without an end one hour long', () => {
    const range = defaultQuickCreateRange(new Date(2026, 9, 5, 23, 30));
    expect(range).toEqual({ startDate: '2026-10-05', startTime: '23:30', endDate: '2026-10-06', endTime: '00:30' });
  });
});

describe('shiftEndDate', () => {
  it('moves the end date by as many days as the start date moved', () => {
    expect(shiftEndDate('2026-10-02', '2026-10-05', '2026-10-02')).toBe('2026-10-05');
    expect(shiftEndDate('2026-10-02', '2026-10-05', '2026-10-03')).toBe('2026-10-06');
    expect(shiftEndDate('2026-10-05', '2026-10-01', '2026-10-05')).toBe('2026-10-01');
  });

  it('leaves the end date alone when the start date did not change', () => {
    expect(shiftEndDate('2026-10-02', '2026-10-02', '2026-10-04')).toBe('2026-10-04');
  });
});

describe('defaultRangeForDay', () => {
  const now = new Date(2026, 9, 3, 14, 20);

  it('starts at the next full hour on today', () => {
    const { start, end } = defaultRangeForDay(new Date(2026, 9, 3), now);
    expect(start).toEqual(new Date(2026, 9, 3, 15, 0));
    expect(end).toEqual(new Date(2026, 9, 3, 16, 0));
  });

  it('starts at 09:00 on any other day, never at midnight', () => {
    const { start, end } = defaultRangeForDay(new Date(2026, 9, 14), now);
    expect(start).toEqual(new Date(2026, 9, 14, 9, 0));
    expect(end).toEqual(new Date(2026, 9, 14, 10, 0));
  });

  it('stays on today late in the evening', () => {
    const { start, end } = defaultRangeForDay(new Date(2026, 9, 3), new Date(2026, 9, 3, 23, 30));
    expect(start).toEqual(new Date(2026, 9, 3, 23, 0));
    expect(end).toEqual(new Date(2026, 9, 3, 23, 59));
  });

  it('keeps the clicked day when the day value carries a time', () => {
    const { start } = defaultRangeForDay(new Date(2026, 9, 14, 0, 0), now);
    expect(start.getDate()).toBe(14);
    expect(start.getHours()).toBe(9);
  });
});

describe('resolveQuickCreateTimes', () => {
  const range = (over: Partial<QuickCreateRange>): QuickCreateRange => ({
    startDate: '2026-10-01',
    startTime: '23:00',
    endDate: '2026-10-01',
    endTime: '00:00',
    ...over,
  });

  it('rolls an end at or before the start to the next day (23:00 - 00:00)', () => {
    const { start, end } = resolveQuickCreateTimes(range({}), false);
    expect(start).toEqual(new Date(2026, 9, 1, 23, 0));
    expect(end).toEqual(new Date(2026, 9, 2, 0, 0));
  });

  it('rolls an end equal to the start by a day too', () => {
    const { start, end } = resolveQuickCreateTimes(range({ startTime: '09:00', endTime: '09:00' }), false);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('keeps an end that is already after the start', () => {
    const { end } = resolveQuickCreateTimes(range({ startTime: '09:00', endTime: '10:30' }), false);
    expect(end).toEqual(new Date(2026, 9, 1, 10, 30));
  });

  it('uses the end date when it is after the start date', () => {
    const { end } = resolveQuickCreateTimes(range({ endDate: '2026-10-02', endTime: '23:00' }), false);
    expect(end).toEqual(new Date(2026, 9, 2, 23, 0));
  });

  it('never ends before the start when the end date is earlier', () => {
    const { start, end } = resolveQuickCreateTimes(range({ endDate: '2026-09-30', endTime: '22:00' }), false);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('treats a blank time as midnight instead of an invalid date', () => {
    const { start, end } = resolveQuickCreateTimes(range({ startTime: '', endTime: '' }), false);
    expect(Number.isNaN(start.getTime())).toBe(false);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('spans whole days for all-day events', () => {
    const { start, end } = resolveQuickCreateTimes(range({ endDate: '2026-10-03' }), true);
    expect(start).toEqual(new Date(2026, 9, 1, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 9, 3, 23, 59, 59));
  });

  it('normalizes the range the card displays', () => {
    expect(normalizeQuickCreateRange(range({}), false)).toEqual({
      startDate: '2026-10-01',
      startTime: '23:00',
      endDate: '2026-10-02',
      endTime: '00:00',
    });
  });
});

describe('resolveTaskSlot', () => {
  const now = new Date(2026, 9, 3, 14, 20);
  const clickedDay = new Date(2026, 9, 14, 9, 0);
  const clicked = { start: clickedDay, end: new Date(2026, 9, 14, 10, 0) };

  it('pins nothing without a due date', () => {
    expect(resolveTaskSlot(undefined, '', clicked, now)).toBeNull();
  });

  it('pins to the due date at its time', () => {
    const slot = resolveTaskSlot(new Date(2026, 9, 14), '16:30', clicked, now);
    expect(slot?.start).toEqual(new Date(2026, 9, 14, 16, 30));
    expect(slot?.durationMinutes).toBe(60);
  });

  it('uses the clicked slot when the time was cleared on the clicked day', () => {
    const slot = resolveTaskSlot(new Date(2026, 9, 14), '', clicked, now);
    expect(slot?.start).toEqual(clickedDay);
  });

  it('uses the default slot of another day and drops the clicked duration', () => {
    const slot = resolveTaskSlot(new Date(2026, 9, 20), '', clicked, now);
    expect(slot?.start).toEqual(new Date(2026, 9, 20, 9, 0));
    expect(slot?.durationMinutes).toBeNull();
  });
});

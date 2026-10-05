import { describe, expect, it } from 'vitest';
import { bucketMonthEvents, dragDeltaDays, shiftEventByDays } from './month-events';
import { dayKey, type SpanEvent } from './event-days';

const d = (day: number, h = 0, m = 0, s = 0) => new Date(2026, 9, day, h, m, s);

type Named = SpanEvent & { name: string };
const allDay = (name: string, from: number, to: number): Named => ({
  name,
  allDay: true,
  startTime: d(from),
  endTime: d(to, 23, 59, 59),
});
const timed = (name: string, start: Date, end: Date): Named => ({ name, startTime: start, endTime: end });

const names = (map: ReturnType<typeof bucketMonthEvents<Named>>, day: number) =>
  (map.get(dayKey(d(day))) ?? []).map((e) => e.event.name);

describe('bucketMonthEvents', () => {
  const gridStart = d(1);
  const gridEnd = d(31);

  it('shows an all-day event on every day it covers', () => {
    const map = bucketMonthEvents([allDay('trip', 5, 8)], gridStart, gridEnd);
    expect([4, 5, 6, 7, 8, 9].map((day) => names(map, day))).toEqual([[], ['trip'], ['trip'], ['trip'], ['trip'], []]);
  });

  it('marks only the first day as the start', () => {
    const map = bucketMonthEvents([allDay('trip', 5, 7)], gridStart, gridEnd);
    const starts = [5, 6, 7].map((day) => map.get(dayKey(d(day)))![0].isStart);
    expect(starts).toEqual([true, false, false]);
  });

  it('shows a timed event of 24h or longer on every covered day', () => {
    const map = bucketMonthEvents([timed('long', d(5, 9), d(7, 9))], gridStart, gridEnd);
    expect([5, 6, 7].map((day) => names(map, day))).toEqual([['long'], ['long'], ['long']]);
  });

  it('keeps a short timed event that crosses midnight on its start day only', () => {
    const map = bucketMonthEvents([timed('late', d(5, 22), d(6, 2))], gridStart, gridEnd);
    expect(names(map, 5)).toEqual(['late']);
    expect(names(map, 6)).toEqual([]);
  });

  it('includes grid days for an event that started before the grid', () => {
    const map = bucketMonthEvents([allDay('long', 1, 20)], d(10), d(31));
    expect(names(map, 9)).toEqual([]);
    expect(names(map, 10)).toEqual(['long']);
    expect(names(map, 20)).toEqual(['long']);
    expect(names(map, 21)).toEqual([]);
    // Day 10 is a continuation: it is not the start.
    expect(map.get(dayKey(d(10)))![0].isStart).toBe(false);
  });

  it('puts multi-day events before timed ones, timed by start time', () => {
    const map = bucketMonthEvents(
      [timed('b', d(6, 15), d(6, 16)), timed('a', d(6, 9), d(6, 10)), allDay('trip', 5, 8)],
      gridStart,
      gridEnd,
    );
    expect(names(map, 6)).toEqual(['trip', 'a', 'b']);
  });

  it('drops a timed event that starts outside the grid', () => {
    const map = bucketMonthEvents([timed('x', d(31, 9), d(31, 10))], d(1), d(30));
    expect(map.size).toBe(0);
  });
});

describe('shiftEventByDays', () => {
  it('moves start and end by whole days keeping the time', () => {
    const { start, end } = shiftEventByDays(timed('x', d(5, 9, 30), d(5, 10, 30)), 3);
    expect(start).toEqual(d(8, 9, 30));
    expect(end).toEqual(d(8, 10, 30));
  });

  it('moves a multi-day event as a whole', () => {
    const ev = allDay('trip', 5, 8);
    const { start, end } = shiftEventByDays(ev, -2);
    expect(dayKey(start)).toBe(dayKey(d(3)));
    expect(dayKey(end)).toBe(dayKey(d(6)));
  });

  it('gives an event without an end one hour', () => {
    const { start, end } = shiftEventByDays({ startTime: d(5, 9) }, 1);
    expect(start).toEqual(d(6, 9));
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('dragDeltaDays', () => {
  it('counts days between the grabbed day and the drop day', () => {
    expect(dragDeltaDays('2026-10-07', '2026-10-09')).toBe(2);
    expect(dragDeltaDays('2026-10-07', '2026-10-05')).toBe(-2);
    expect(dragDeltaDays('2026-10-07', '2026-10-07')).toBe(0);
  });

  it('moves a multi-day event by the grab-relative delta, not the start-relative one', () => {
    // Event Oct 5-8 grabbed on Oct 7, dropped on Oct 9: shift +2, so it starts Oct 7.
    const delta = dragDeltaDays('2026-10-07', '2026-10-09');
    expect(dayKey(shiftEventByDays(allDay('trip', 5, 8), delta).start)).toBe('2026-10-07');
  });
});

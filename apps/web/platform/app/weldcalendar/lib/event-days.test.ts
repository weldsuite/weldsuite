import { describe, expect, it } from 'vitest';
import {
  countEventsByDay,
  eventCoversDay,
  eventDayRange,
  isAllDayRowEvent,
  layoutAllDayRow,
  timedEventsForDay,
  timedSegmentForDay,
  type SpanEvent,
} from './event-days';

const d = (day: number, h = 0, m = 0, s = 0) => new Date(2026, 9, day, h, m, s);
// Mon 5 Oct 2026 .. Sun 11 Oct 2026
const week = Array.from({ length: 7 }, (_, i) => d(5 + i));

const allDay = (name: string, from: number, to: number): SpanEvent & { name: string } => ({
  name,
  allDay: true,
  startTime: d(from),
  endTime: d(to, 23, 59, 59),
});

const nameOf = (bar: { event: unknown }) => (bar.event as { name: string }).name;

describe('isAllDayRowEvent', () => {
  it('includes all-day events', () => {
    expect(isAllDayRowEvent({ allDay: true, startTime: d(5), endTime: d(5, 23, 59, 59) })).toBe(true);
  });

  it('includes timed events of 24 hours or more', () => {
    expect(isAllDayRowEvent({ startTime: d(5, 9), endTime: d(6, 9) })).toBe(true);
    expect(isAllDayRowEvent({ startTime: d(5, 9), endTime: d(7, 17) })).toBe(true);
  });

  it('keeps shorter timed events in the grid, even across midnight', () => {
    expect(isAllDayRowEvent({ startTime: d(5, 9), endTime: d(5, 10) })).toBe(false);
    expect(isAllDayRowEvent({ startTime: d(5, 22), endTime: d(6, 2) })).toBe(false);
    expect(isAllDayRowEvent({ startTime: d(5, 9) })).toBe(false);
  });
});

describe('eventDayRange', () => {
  it('covers inclusive end days', () => {
    const { first, last } = eventDayRange(allDay('a', 5, 7));
    expect(first).toEqual(d(5));
    expect(last).toEqual(d(7));
  });

  it('treats an end exactly at midnight as exclusive (synced all-day events)', () => {
    const { last } = eventDayRange({ allDay: true, startTime: d(5), endTime: d(7) });
    expect(last).toEqual(d(6));
  });

  it('falls back to a single day for missing or backwards ends', () => {
    expect(eventDayRange({ startTime: d(5, 10) }).last).toEqual(d(5));
    expect(eventDayRange({ startTime: d(5, 10), endTime: d(5, 9, 30) }).last).toEqual(d(5));
    expect(eventDayRange({ startTime: d(5, 10), endTime: 'garbage' }).last).toEqual(d(5));
  });

  it('accepts ISO strings', () => {
    const e = { startTime: d(5, 9).toISOString(), endTime: d(6, 9).toISOString() };
    expect(eventCoversDay(e, d(6, 15))).toBe(true);
    expect(eventCoversDay(e, d(7))).toBe(false);
  });
});

describe('timedSegmentForDay', () => {
  const overnight = { startTime: d(5, 22), endTime: d(6, 2) };

  it('clips an overnight event to each day it touches', () => {
    expect(timedSegmentForDay(overnight, d(5))).toEqual({
      start: d(5, 22),
      end: d(6),
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(timedSegmentForDay(overnight, d(6))).toEqual({
      start: d(6),
      end: d(6, 2),
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it('returns null for days it does not touch', () => {
    expect(timedSegmentForDay(overnight, d(4))).toBeNull();
    expect(timedSegmentForDay(overnight, d(7))).toBeNull();
  });

  it('does not spill an event that ends exactly at midnight into the next day', () => {
    const evening = { startTime: d(5, 20), endTime: d(6) };
    expect(timedSegmentForDay(evening, d(5))?.continuesAfter).toBe(false);
    expect(timedSegmentForDay(evening, d(6))).toBeNull();
  });

  it('keeps an event without an end on its start day only', () => {
    const open = { startTime: d(5, 23, 30) };
    expect(timedSegmentForDay(open, d(5))).not.toBeNull();
    expect(timedSegmentForDay(open, d(6))).toBeNull();
  });
});

describe('timedEventsForDay', () => {
  it('leaves all-day-row events out of the grid', () => {
    const events = [
      { name: 'trip', startTime: d(5, 9), endTime: d(7, 9) },
      { name: 'standup', startTime: d(6, 9), endTime: d(6, 9, 15) },
      { name: 'offsite', allDay: true, startTime: d(6), endTime: d(6, 23, 59, 59) },
    ];
    expect(timedEventsForDay(events, d(6)).map((x) => x.event.name)).toEqual(['standup']);
  });
});

describe('layoutAllDayRow', () => {
  it('returns nothing for timed events or an empty window', () => {
    expect(layoutAllDayRow([{ startTime: d(5, 9), endTime: d(5, 10) }], week)).toEqual({ bars: [], laneCount: 0 });
    expect(layoutAllDayRow([allDay('a', 5, 5)], [])).toEqual({ bars: [], laneCount: 0 });
  });

  it('spans a multi-day event across the days it covers', () => {
    const { bars, laneCount } = layoutAllDayRow([allDay('conf', 6, 8)], week);
    expect(laneCount).toBe(1);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ startCol: 1, endCol: 3, lane: 0, continuesBefore: false, continuesAfter: false });
  });

  it('clips events that start before or end after the visible days', () => {
    const { bars } = layoutAllDayRow([allDay('long', 1, 20)], week);
    expect(bars[0]).toMatchObject({ startCol: 0, endCol: 6, continuesBefore: true, continuesAfter: true });
  });

  it('skips events outside the window', () => {
    const { bars } = layoutAllDayRow([allDay('past', 1, 3), allDay('future', 15, 16)], week);
    expect(bars).toEqual([]);
  });

  it('stacks overlapping bars in lanes and reuses free lanes', () => {
    const { bars, laneCount } = layoutAllDayRow([allDay('c', 8, 8), allDay('b', 6, 6), allDay('a', 5, 7)], week);
    expect(laneCount).toBe(2);
    const lane = (name: string) => bars.find((bar) => nameOf(bar) === name)?.lane;
    expect(lane('a')).toBe(0);
    expect(lane('b')).toBe(1);
    expect(lane('c')).toBe(0);
  });

  it('puts the longer event first when two start on the same day', () => {
    const { bars } = layoutAllDayRow([allDay('short', 5, 5), allDay('long', 5, 9)], week);
    expect(bars.map(nameOf)).toEqual(['long', 'short']);
    expect(bars[0].lane).toBe(0);
  });

  it('includes timed events spanning 24h or more', () => {
    const { bars } = layoutAllDayRow([{ startTime: d(6, 9), endTime: d(8, 9) }], week);
    expect(bars[0]).toMatchObject({ startCol: 1, endCol: 3 });
  });

  it('works for a single-day window (Day view)', () => {
    const { bars } = layoutAllDayRow([allDay('x', 4, 6)], [d(5)]);
    expect(bars[0]).toMatchObject({ startCol: 0, endCol: 0, continuesBefore: true, continuesAfter: true });
  });
});

describe('countEventsByDay', () => {
  it('counts each event on every day it covers', () => {
    const counts = countEventsByDay([
      allDay('trip', 5, 7),
      { startTime: d(6, 9), endTime: d(6, 10) },
      { startTime: d(6, 23), endTime: d(7, 1) },
    ]);
    expect(counts.get('2026-10-05')).toBe(1);
    expect(counts.get('2026-10-06')).toBe(3);
    expect(counts.get('2026-10-07')).toBe(2);
    expect(counts.get('2026-10-08')).toBeUndefined();
  });
});

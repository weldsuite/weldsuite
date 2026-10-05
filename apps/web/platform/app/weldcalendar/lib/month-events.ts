/**
 * Which events the month grid draws on which day, and how a dragged chip moves
 * its event.
 *
 * Events that belong in the all-day row of the time-grid views (all-day events
 * and anything 24h or longer) are drawn on **every** day they cover. Any other
 * event is drawn once, on the day it starts, even when it crosses midnight.
 */

import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns';
import { dayKey, eventBounds, eventDayRange, isAllDayRowEvent, type SpanEvent } from './event-days';

/** One chip of the month grid. */
export interface MonthDayEntry<T extends SpanEvent> {
  event: T;
  /** True on the first day of the event, false on the days it carries on. */
  isStart: boolean;
}

/**
 * Bucket events by day (`yyyy-MM-dd`, local) for the grid window
 * `[gridStart, gridEnd]` (inclusive calendar days). Days outside the window are
 * skipped, so a very long event costs no more than the grid is wide.
 *
 * Inside a day, multi-day / all-day events come first (by start), then timed
 * events by start time; ties keep the input order.
 */
export function bucketMonthEvents<T extends SpanEvent>(
  events: readonly T[],
  gridStart: Date,
  gridEnd: Date,
): Map<string, MonthDayEntry<T>[]> {
  const windowStart = startOfDay(gridStart);
  const windowEnd = startOfDay(gridEnd);
  const buckets = new Map<string, MonthDayEntry<T>[]>();
  const sortKey = new Map<T, { row: number; start: number }>();

  const push = (day: Date, entry: MonthDayEntry<T>) => {
    const key = dayKey(day);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  };

  for (const event of events) {
    const { first, last } = eventDayRange(event);
    const rowEvent = isAllDayRowEvent(event);
    sortKey.set(event, { row: rowEvent ? 0 : 1, start: eventBounds(event).start.getTime() });

    if (!rowEvent) {
      if (first.getTime() >= windowStart.getTime() && first.getTime() <= windowEnd.getTime()) {
        push(first, { event, isStart: true });
      }
      continue;
    }

    const from = first.getTime() < windowStart.getTime() ? windowStart : first;
    const to = last.getTime() > windowEnd.getTime() ? windowEnd : last;
    const days = differenceInCalendarDays(to, from);
    for (let i = 0; i <= days; i++) {
      const day = addDays(from, i);
      push(day, { event, isStart: differenceInCalendarDays(day, first) === 0 });
    }
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const ka = sortKey.get(a.event);
      const kb = sortKey.get(b.event);
      if (!ka || !kb) return 0;
      return ka.row - kb.row || ka.start - kb.start;
    });
  }
  return buckets;
}

/**
 * Move an event by a whole number of calendar days, keeping its time of day
 * (wall clock, so a daylight-saving change does not shift it). An event without
 * an end gets a one-hour end.
 */
export function shiftEventByDays(
  event: SpanEvent,
  deltaDays: number,
): { start: Date; end: Date } {
  const { start, end } = eventBounds(event);
  const hasEnd = event.endTime != null;
  const newStart = addDays(start, deltaDays);
  const newEnd = hasEnd ? addDays(end, deltaDays) : new Date(newStart.getTime() + 60 * 60 * 1000);
  return { start: newStart, end: newEnd };
}

/**
 * Whole days between the day a chip was grabbed on and the day it was dropped
 * on. Both are `yyyy-MM-dd` keys.
 */
export function dragDeltaDays(originKey: string, dropKey: string): number {
  return differenceInCalendarDays(new Date(`${dropKey}T00:00:00`), new Date(`${originKey}T00:00:00`));
}

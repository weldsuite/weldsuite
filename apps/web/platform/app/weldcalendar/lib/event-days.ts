/**
 * Which days an event covers, and how the calendar views place it.
 *
 * The time-grid views (Day / 4 Days / Week) have two places an event can live:
 *
 * - the **all-day row** above the grid: all-day events and any event that runs
 *   for 24 hours or more, drawn as a bar across every day it covers;
 * - the **time grid** itself: every other event. A timed event that crosses
 *   midnight (but is shorter than 24h) is drawn once per day it touches, each
 *   segment clipped to that day.
 *
 * Everything here is pure (local-time `Date`s in, plain data out) so the rules
 * are unit-tested without a layout engine.
 */

import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Safety cap when walking the days of a very long event. */
const MAX_COVERED_DAYS = 400;

/** The slice of a calendar event the layout rules look at. */
export interface SpanEvent {
  allDay?: boolean;
  startTime: string | Date;
  endTime?: string | Date | null;
}

/** First instant and (inclusive) last instant of an event; `end >= start`. */
export interface EventBounds {
  start: Date;
  end: Date;
}

/**
 * Start / end of an event as `Date`s. A missing, invalid or backwards end
 * collapses to the start, so malformed data covers one day rather than
 * producing a negative span.
 */
export function eventBounds(event: SpanEvent): EventBounds {
  const start = new Date(event.startTime);
  if (event.endTime == null) return { start, end: start };
  const end = new Date(event.endTime);
  if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return { start, end: start };
  return { start, end };
}

/**
 * Last instant that still belongs to the event. An end that sits exactly on
 * local midnight (and is after the start) is treated as exclusive, which is how
 * externally synced all-day events are stored, so they do not spill into an
 * extra day.
 */
function lastInstant({ start, end }: EventBounds): Date {
  const atMidnight =
    end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0;
  if (atMidnight && end.getTime() > start.getTime()) return new Date(end.getTime() - 1);
  return end;
}

/** First and last calendar day (local midnight) the event covers. */
export function eventDayRange(event: SpanEvent): { first: Date; last: Date } {
  const bounds = eventBounds(event);
  const first = startOfDay(bounds.start);
  const last = startOfDay(lastInstant(bounds));
  return { first, last: last.getTime() < first.getTime() ? first : last };
}

/** Every calendar day the event covers (capped, see `MAX_COVERED_DAYS`). */
export function eventCoveredDays(event: SpanEvent): Date[] {
  const { first, last } = eventDayRange(event);
  const count = Math.min(differenceInCalendarDays(last, first) + 1, MAX_COVERED_DAYS);
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/** True when the event belongs in the all-day row: all-day, or 24h or longer. */
export function isAllDayRowEvent(event: SpanEvent): boolean {
  if (event.allDay) return true;
  const { start, end } = eventBounds(event);
  return end.getTime() - start.getTime() >= DAY_MS;
}

/** True when the event touches the given calendar day. */
export function eventCoversDay(event: SpanEvent, day: Date): boolean {
  const { first, last } = eventDayRange(event);
  const d = startOfDay(day).getTime();
  return d >= first.getTime() && d <= last.getTime();
}

// ---------------------------------------------------------------------------
// Time grid
// ---------------------------------------------------------------------------

/** The part of a timed event drawn in one day's column. */
export interface TimedSegment {
  /** Clipped to the day: never earlier than 00:00 of the day. */
  start: Date;
  /** Clipped to the day: never later than 00:00 of the next day. */
  end: Date;
  /** The event started on an earlier day (this is a continuation). */
  continuesBefore: boolean;
  /** The event runs on into a later day. */
  continuesAfter: boolean;
}

/**
 * The slice of a timed event that falls on `day`, or `null` if it does not
 * touch that day. Meant for events that are not all-day-row events; those are
 * placed by `layoutAllDayRow`.
 */
export function timedSegmentForDay(event: SpanEvent, day: Date): TimedSegment | null {
  const dayStart = startOfDay(day);
  const nextDayStart = addDays(dayStart, 1);
  const { start, end } = eventBounds(event);
  const last = lastInstant({ start, end });

  if (start.getTime() >= nextDayStart.getTime()) return null;
  if (last.getTime() < dayStart.getTime()) return null;

  const continuesBefore = start.getTime() < dayStart.getTime();
  const continuesAfter = end.getTime() > nextDayStart.getTime();
  return {
    start: continuesBefore ? dayStart : start,
    end: continuesAfter ? nextDayStart : end,
    continuesBefore,
    continuesAfter,
  };
}

export interface DayTimedEvent<T extends SpanEvent> {
  event: T;
  segment: TimedSegment;
}

/** Events (with their clipped segment) to draw in the time grid for `day`. */
export function timedEventsForDay<T extends SpanEvent>(events: readonly T[], day: Date): DayTimedEvent<T>[] {
  const result: DayTimedEvent<T>[] = [];
  for (const event of events) {
    if (isAllDayRowEvent(event)) continue;
    const segment = timedSegmentForDay(event, day);
    if (segment) result.push({ event, segment });
  }
  return result;
}

// ---------------------------------------------------------------------------
// All-day row
// ---------------------------------------------------------------------------

export interface AllDayBar<T extends SpanEvent> {
  event: T;
  /** Zero-based index of the first visible day the bar covers. */
  startCol: number;
  /** Zero-based index of the last visible day the bar covers (inclusive). */
  endCol: number;
  /** Row inside the all-day area, zero-based. */
  lane: number;
  /** The event begins before the first visible day. */
  continuesBefore: boolean;
  /** The event runs on past the last visible day. */
  continuesAfter: boolean;
}

export interface AllDayLayout<T extends SpanEvent> {
  bars: AllDayBar<T>[];
  /** Number of rows needed (0 when there is nothing to show). */
  laneCount: number;
}

/**
 * Lay the all-day-row events out over the visible `days` (consecutive calendar
 * days, left to right). Each event becomes one bar spanning the days it covers,
 * clipped to the visible window; overlapping bars are stacked in lanes, longest
 * first so a week-long event does not get pushed below a one-day one.
 */
export function layoutAllDayRow<T extends SpanEvent>(events: readonly T[], days: readonly Date[]): AllDayLayout<T> {
  if (days.length === 0) return { bars: [], laneCount: 0 };
  const windowStart = startOfDay(days[0]);
  const lastCol = days.length - 1;

  const candidates: Omit<AllDayBar<T>, 'lane'>[] = [];
  for (const event of events) {
    if (!isAllDayRowEvent(event)) continue;
    const { first, last } = eventDayRange(event);
    const rawStart = differenceInCalendarDays(first, windowStart);
    const rawEnd = differenceInCalendarDays(last, windowStart);
    if (rawEnd < 0 || rawStart > lastCol) continue;
    candidates.push({
      event,
      startCol: Math.max(rawStart, 0),
      endCol: Math.min(rawEnd, lastCol),
      continuesBefore: rawStart < 0,
      continuesAfter: rawEnd > lastCol,
    });
  }

  candidates.sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    const spanDiff = b.endCol - b.startCol - (a.endCol - a.startCol);
    if (spanDiff !== 0) return spanDiff;
    return eventBounds(a.event).start.getTime() - eventBounds(b.event).start.getTime();
  });

  const laneEnds: number[] = [];
  const bars: AllDayBar<T>[] = candidates.map((candidate) => {
    let lane = laneEnds.findIndex((end) => end < candidate.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(candidate.endCol);
    } else {
      laneEnds[lane] = candidate.endCol;
    }
    return { ...candidate, lane };
  });

  return { bars, laneCount: laneEnds.length };
}

// ---------------------------------------------------------------------------
// Year view
// ---------------------------------------------------------------------------

/**
 * Number of events on each day, keyed `yyyy-MM-dd` (local). Every event counts
 * once on each day it covers, so all-day and multi-day events light up their
 * whole span.
 */
export function countEventsByDay(events: readonly SpanEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const day of eventCoveredDays(event)) {
      const key = dayKey(day);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** `yyyy-MM-dd` in local time (cheaper than date-fns `format` in hot loops). */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

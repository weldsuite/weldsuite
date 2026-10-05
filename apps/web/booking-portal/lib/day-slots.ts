/**
 * The bookable slots of one calendar date, from a booking page's rules.
 *
 * The rules live here once; where the events and bookings come from does not:
 * a workspace page reads the tenant database, a personal page the personal one.
 * Each passes a {@link DaySlotsSource}, so this file never touches a database
 * and is unit-tested with a fake source.
 *
 * Rules (the calendar-api worker applies the same):
 *  - an event blocks a slot when it overlaps it (plus the buffers), whether it
 *    starts that day or earlier; `confirmed` and `tentative` block, `cancelled`
 *    and deleted ones do not
 *  - `minNotice` minutes, `maxAdvance` days (nothing beyond is bookable)
 *  - a `dateOverrides` entry replaces the weekly ranges for its date
 *  - `maxBookingsPerDay` (> 0) closes a day that has reached it
 */

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import {
  DEFAULT_EVENT_MINUTES,
  addDaysToDate,
  buildSlots,
  findSlot,
  isBeyondMaxAdvance,
  isDayFull,
  rangesForDate,
  weekdayOfDate,
  type BusyEvent,
  type DateOverrideLike,
  type Slot,
  type WeeklyAvailabilityLike,
} from './availability.ts';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real `YYYY-MM-DD` calendar date. */
export function isCalendarDate(value: string): boolean {
  return CALENDAR_DATE.test(value) && weekdayOfDate(value) !== null;
}

/** The calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function dateInTimezone(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}

/** What a page's rules need; the caller maps its page row onto this. */
export interface DaySlotsPage {
  /** IANA timezone the weekly availability and overrides are written in. */
  timezone: string;
  weekly: WeeklyAvailabilityLike;
  overrides?: readonly DateOverrideLike[] | null;
  durationMinutes: number;
  bufferBeforeMinutes?: number | null;
  bufferAfterMinutes?: number | null;
  minNoticeMinutes?: number | null;
  maxAdvanceDays?: number | null;
  /** null or 0 = unlimited. */
  maxBookingsPerDay?: number | null;
}

export interface DaySlotsSource {
  /**
   * The host's events that overlap [from, to): `confirmed` or `tentative`, not
   * deleted, excluding the booking being moved when there is one. A superset is
   * fine, the overlap is tested again per slot.
   */
  busyEvents(from: Date, to: Date): Promise<BusyEvent[]>;
  /** Non-cancelled bookings of the page that start in [from, to), excluding the one being moved. */
  bookingCount(from: Date, to: Date): Promise<number>;
}

const MINUTE_MS = 60_000;

/** Slots (available or not) of `date`, or an empty list when the day offers none. */
export async function computeDaySlots(
  page: DaySlotsPage,
  date: string,
  source: DaySlotsSource,
  now: Date = new Date(),
): Promise<Slot[]> {
  if (!isCalendarDate(date)) return [];
  const tz = page.timezone || 'UTC';

  if (isBeyondMaxAdvance(date, dateInTimezone(now, tz), page.maxAdvanceDays)) return [];

  const ranges = rangesForDate(date, page.weekly, page.overrides);
  if (ranges.length === 0) return [];

  const nextDate = addDaysToDate(date, 1);
  if (!nextDate) return [];
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${nextDate}T00:00:00`, tz);

  // The buffers reach past midnight, so look that far for events too.
  const from = new Date(dayStart.getTime() - (page.bufferBeforeMinutes ?? 0) * MINUTE_MS);
  const to = new Date(dayEnd.getTime() + (page.bufferAfterMinutes ?? 0) * MINUTE_MS);

  const capped = !!page.maxBookingsPerDay && page.maxBookingsPerDay > 0;
  const [busy, bookingsOnDay] = await Promise.all([
    source.busyEvents(from, to),
    capped ? source.bookingCount(dayStart, dayEnd) : Promise.resolve(0),
  ]);

  return buildSlots({
    ranges,
    durationMinutes: page.durationMinutes,
    bufferBeforeMinutes: page.bufferBeforeMinutes,
    bufferAfterMinutes: page.bufferAfterMinutes,
    minNoticeMinutes: page.minNoticeMinutes,
    now,
    busy,
    dayFull: isDayFull(bookingsOnDay, page.maxBookingsPerDay),
    toInstant: (hhmm) => fromZonedTime(`${date}T${hhmm}:00`, tz),
  });
}

/**
 * True when the exact slot is still bookable. Used by create and reschedule
 * right before they write: the same rules as the picker, evaluated again.
 */
export async function isSlotStillAvailable(
  page: DaySlotsPage,
  startIso: string,
  endIso: string,
  source: DaySlotsSource,
  now: Date = new Date(),
): Promise<boolean> {
  const date = dateInTimezone(new Date(startIso), page.timezone || 'UTC');
  const slots = await computeDaySlots(page, date, source, now);
  return findSlot(slots, startIso, endIso)?.available === true;
}

/** How long an event without an end time is assumed to last (for the overlap query). */
export const EVENT_WITHOUT_END_MS = DEFAULT_EVENT_MINUTES * MINUTE_MS;

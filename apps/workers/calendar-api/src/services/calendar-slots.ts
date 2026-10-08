/**
 * Booking-page slot availability.
 *
 * Ported from apps/api-worker/src/routes/calendar/booking-pages.ts
 * (`GET /:id/available-slots`, W5b of the legacy-worker phase-out).
 * Pure functions, no Hono context.
 *
 * TIMEZONE MATH: the legacy route used `date-fns-tz` (`fromZonedTime` /
 * `toZonedTime`). app-api does not depend on `date-fns-tz`, so the two
 * conversions it needed are implemented below on `Intl.DateTimeFormat`,
 * which is available in workerd and needs no new dependency.
 */

import { and, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { getOwnedCalendarIds } from './calendar-access';

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface AvailabilityRange {
  start: string; // "09:00"
  end: string; // "17:00"
}

export type WeeklyAvailability = Record<string, AvailabilityRange[]>;

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

// ── Timezone helpers (replacement for date-fns-tz) ───────────────────────

/**
 * The offset of `timeZone` at a given instant, in ms (east of UTC positive).
 * Derived by reading the instant's wall-clock in the zone and diffing it
 * against the instant itself.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const f: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal' && p.type !== 'timeZoneName') f[p.type] = Number(p.value);
  }

  const wallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // Zone offsets are whole minutes; drop sub-second noise from the instant so
  // the diff is exactly the offset.
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Interpret a wall-clock string (`YYYY-MM-DDTHH:mm:ss[.sss]`, no zone suffix)
 * as local time in `timeZone` and return the UTC instant — i.e. date-fns-tz's
 * `fromZonedTime`.
 */
export function fromZonedTime(wallClock: string, timeZone: string): Date {
  const naive = Date.parse(`${wallClock}Z`);
  if (Number.isNaN(naive)) {
    throw new TypeError(`Invalid wall-clock timestamp: ${wallClock}`);
  }
  // First pass uses the offset at the naive instant; re-read it at the
  // resulting instant so DST transitions resolve to the correct side.
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
}

/**
 * Weekday name for a calendar date (`YYYY-MM-DD`).
 *
 * DELIBERATE DIVERGENCE FROM LEGACY: the legacy route ran the date through
 * `toZonedTime(new Date(`${date}T00:00:00Z`), tz).getDay()`, which shifts
 * UTC midnight into the zone and therefore lands on the *previous* day for
 * any negative-offset zone (e.g. America/New_York resolved Thursday's date to
 * Wednesday's availability). `date` is already a calendar date in the page's
 * own timezone, so its weekday needs no conversion. Identical to legacy for
 * UTC (the column default) and every non-negative offset; a fix for the rest.
 */
export function weekdayNameForDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date: ${date}`);
  return DAY_NAMES[new Date(parsed).getUTCDay()];
}

// ── Slot computation ─────────────────────────────────────────────────────

/** Availability for one specific date; replaces the weekly availability for it. */
export interface DateOverride {
  date: string; // YYYY-MM-DD in the page timezone
  slots: AvailabilityRange[];
}

export interface BookingPageSlotConfig {
  id: string;
  ownerId: string;
  availability: WeeklyAvailability | null;
  timezone: string | null;
  duration: number;
  bufferBefore: number | null;
  bufferAfter: number | null;
  /** Minutes of notice required; null falls back to 60. */
  minNotice: number | null;
  /** Days ahead a slot can be booked; null = no limit. */
  maxAdvance?: number | null;
  dateOverrides?: DateOverride[] | null;
  /** Cap on non-cancelled bookings per day; null or 0 = unlimited. */
  maxBookingsPerDay?: number | null;
}

/** The calendar date after `date` (both YYYY-MM-DD). */
function nextDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date: ${date}`);
  return new Date(parsed + 24 * 60 * 60000).toISOString().slice(0, 10);
}

/**
 * Compute the bookable slots for one calendar date.
 *
 * The windows of that date are the page's override for it when there is one
 * (empty = closed), else the weekly availability for its weekday. They are
 * walked in `duration`-minute steps; a slot is unavailable when
 *   - it (plus its buffers) overlaps an event of the owner that is confirmed or
 *     tentative: one whose organizer is the owner or that sits on a calendar the
 *     owner owns, all-day and multi-day events included, no matter on which day
 *     the event started;
 *   - it falls inside the minimum-notice window;
 *   - the date is further ahead than `maxAdvance` days;
 *   - the page already has `maxBookingsPerDay` non-cancelled bookings that day
 *     (in the page timezone).
 */
export async function computeAvailableSlots(
  db: Database,
  page: BookingPageSlotConfig,
  date: string,
  now: number = Date.now(),
): Promise<TimeSlot[]> {
  const { calendarEvents, calendarBookings } = schema;

  const availability = page.availability ?? {};
  const tz = page.timezone || 'UTC';
  const override = (page.dateOverrides ?? []).find((o) => o.date === date);
  const daySlots = override ? override.slots : (availability[weekdayNameForDate(date)] ?? []);
  if (daySlots.length === 0) return [];

  // Day window [dayStart, dayEnd), in the page's timezone.
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${nextDate(date)}T00:00:00`, tz);

  // Events that OVERLAP the day, not just those starting in it.
  const ownedCalendarIds = await getOwnedCalendarIds(db, page.ownerId);
  const existingEvents = await db
    .select({ startTime: calendarEvents.startTime, endTime: calendarEvents.endTime })
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.deletedAt),
        ownedCalendarIds.length > 0
          ? or(
              eq(calendarEvents.organizerId, page.ownerId),
              inArray(calendarEvents.calendarId, ownedCalendarIds),
            )
          : eq(calendarEvents.organizerId, page.ownerId),
        inArray(calendarEvents.status, ['confirmed', 'tentative']),
        lt(calendarEvents.startTime, dayEnd),
        gt(
          sql`coalesce(${calendarEvents.endTime}, ${calendarEvents.startTime} + interval '30 minutes')`,
          dayStart,
        ),
      ),
    );

  const duration = page.duration;
  const bufferBefore = page.bufferBefore ?? 0;
  const bufferAfter = page.bufferAfter ?? 0;
  const minNoticeMs = (page.minNotice ?? 60) * 60000;

  const beyondHorizon =
    page.maxAdvance != null && dayStart.getTime() > now + page.maxAdvance * 24 * 60 * 60000;

  let dayFull = false;
  if (page.maxBookingsPerDay != null && page.maxBookingsPerDay > 0) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(calendarBookings)
      .where(
        and(
          eq(calendarBookings.bookingPageId, page.id),
          isNull(calendarBookings.deletedAt),
          ne(calendarBookings.status, 'cancelled'),
          gte(calendarBookings.startTime, dayStart),
          lt(calendarBookings.startTime, dayEnd),
        ),
      );
    dayFull = Number(row?.count ?? 0) >= page.maxBookingsPerDay;
  }

  const slots: TimeSlot[] = [];

  for (const range of daySlots) {
    const rangeStart = fromZonedTime(`${date}T${range.start}:00`, tz);
    const rangeEnd = fromZonedTime(`${date}T${range.end}:00`, tz);

    let current = rangeStart.getTime();

    while (current + duration * 60000 <= rangeEnd.getTime()) {
      const slotStart = new Date(current);
      const slotEnd = new Date(current + duration * 60000);

      // Buffers widen the slot for conflict purposes only, not for display.
      const bufferedStart = slotStart.getTime() - bufferBefore * 60000;
      const bufferedEnd = slotEnd.getTime() + bufferAfter * 60000;

      const hasConflict = existingEvents.some((evt) => {
        const evtStart = new Date(evt.startTime).getTime();
        // Events without an end are treated as 30 minutes long (legacy parity).
        const evtEnd = evt.endTime ? new Date(evt.endTime).getTime() : evtStart + 30 * 60000;
        return bufferedStart < evtEnd && bufferedEnd > evtStart;
      });

      const tooSoon = slotStart.getTime() - now < minNoticeMs;

      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        available: !hasConflict && !tooSoon && !beyondHorizon && !dayFull,
      });

      current += duration * 60000;
    }
  }

  return slots;
}

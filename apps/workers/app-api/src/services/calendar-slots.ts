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

import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';

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
    throw new Error(`Invalid wall-clock timestamp: ${wallClock}`);
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

export interface BookingPageSlotConfig {
  ownerId: string;
  availability: WeeklyAvailability | null;
  timezone: string | null;
  duration: number;
  bufferBefore: number | null;
  bufferAfter: number | null;
  minNotice: number | null;
}

/**
 * Compute the bookable slots for one calendar date.
 *
 * Walks each availability window for that weekday in `duration`-minute steps
 * and marks a slot unavailable when it (plus its buffers) overlaps one of the
 * owner's confirmed events, or when it falls inside the minimum-notice window.
 */
export async function computeAvailableSlots(
  db: Database,
  page: BookingPageSlotConfig,
  date: string,
): Promise<TimeSlot[]> {
  const { calendarEvents } = schema;

  const availability = page.availability ?? {};
  const tz = page.timezone || 'UTC';
  const daySlots = availability[weekdayNameForDate(date)] ?? [];
  if (daySlots.length === 0) return [];

  // Day window, in the owner's timezone.
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${date}T23:59:59.999`, tz);

  const existingEvents = await db
    .select({ startTime: calendarEvents.startTime, endTime: calendarEvents.endTime })
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.deletedAt),
        eq(calendarEvents.organizerId, page.ownerId),
        gte(calendarEvents.startTime, dayStart),
        lte(calendarEvents.startTime, dayEnd),
        eq(calendarEvents.status, 'confirmed'),
      ),
    );

  const duration = page.duration;
  const bufferBefore = page.bufferBefore ?? 0;
  const bufferAfter = page.bufferAfter ?? 0;
  const minNoticeMs = (page.minNotice ?? 60) * 60000;
  const now = Date.now();

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
        available: !hasConflict && !tooSoon,
      });

      current += duration * 60000;
    }
  }

  return slots;
}

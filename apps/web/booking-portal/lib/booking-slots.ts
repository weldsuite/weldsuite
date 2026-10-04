/**
 * Workspace booking pages: the tenant-database side of slot availability.
 *
 * The rules are in `day-slots.ts`; this file only reads the host's events and
 * the page's bookings from the tenant database and hands them over.
 */

import { and, count, eq, gt, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  calendarBookings,
  calendarEvents,
  type CalendarBookingPage,
} from '@weldsuite/db/schema';
import type * as tenantSchema from '@weldsuite/db/schema';

import { BLOCKING_EVENT_STATUSES, sanitizeAvailability, type Slot } from './availability';
import {
  EVENT_WITHOUT_END_MS,
  computeDaySlots,
  isSlotStillAvailable,
  type DaySlotsPage,
  type DaySlotsSource,
} from './day-slots';
import { parseDateOverrides, weeklyAvailabilitySchema } from './schemas';

/** A tenant database handle, or a transaction on one. */
export type TenantQueryDb = PgDatabase<PgQueryResultHKT, typeof tenantSchema>;

/** The columns of a booking page that the slot rules read. */
export type SlotPageRow = Pick<
  CalendarBookingPage,
  | 'id'
  | 'ownerId'
  | 'timezone'
  | 'availability'
  | 'dateOverrides'
  | 'duration'
  | 'bufferBefore'
  | 'bufferAfter'
  | 'minNotice'
  | 'maxAdvance'
  | 'maxBookingsPerDay'
>;

/** What to leave out when an existing booking is being moved: it must not block itself. */
export interface SlotExclusions {
  excludeEventId?: string | null;
  excludeBookingId?: string | null;
}

/** Maps a page row onto the rules, or null when its weekly availability is corrupt. */
export function toDaySlotsPage(row: SlotPageRow): DaySlotsPage | null {
  const weekly = weeklyAvailabilitySchema.safeParse(row.availability);
  if (!weekly.success) {
    console.error(
      '[booking-portal] availability JSONB failed schema validation',
      row.id,
      weekly.error.flatten(),
    );
    return null;
  }
  return {
    timezone: row.timezone || 'UTC',
    weekly: sanitizeAvailability(weekly.data),
    overrides: parseDateOverrides(row.dateOverrides),
    durationMinutes: row.duration,
    bufferBeforeMinutes: row.bufferBefore,
    bufferAfterMinutes: row.bufferAfter,
    minNoticeMinutes: row.minNotice,
    maxAdvanceDays: row.maxAdvance,
    maxBookingsPerDay: row.maxBookingsPerDay,
  };
}

function tenantSource(db: TenantQueryDb, row: SlotPageRow, exclude: SlotExclusions): DaySlotsSource {
  return {
    async busyEvents(from, to) {
      // Overlap, not "starts on this day": startTime < to AND end > from, with a
      // missing end taken as 30 minutes. All-day and multi-day events are found.
      const conditions = [
        isNull(calendarEvents.deletedAt),
        eq(calendarEvents.organizerId, row.ownerId),
        inArray(calendarEvents.status, [...BLOCKING_EVENT_STATUSES]),
        lt(calendarEvents.startTime, to),
        or(
          gt(calendarEvents.endTime, from),
          and(
            isNull(calendarEvents.endTime),
            gt(calendarEvents.startTime, new Date(from.getTime() - EVENT_WITHOUT_END_MS)),
          ),
        ),
      ];
      if (exclude.excludeEventId) conditions.push(ne(calendarEvents.id, exclude.excludeEventId));

      return db
        .select({
          startTime: calendarEvents.startTime,
          endTime: calendarEvents.endTime,
          status: calendarEvents.status,
        })
        .from(calendarEvents)
        .where(and(...conditions));
    },

    async bookingCount(from, to) {
      const conditions = [
        eq(calendarBookings.bookingPageId, row.id),
        isNull(calendarBookings.deletedAt),
        ne(calendarBookings.status, 'cancelled'),
        gte(calendarBookings.startTime, from),
        lt(calendarBookings.startTime, to),
      ];
      if (exclude.excludeBookingId) conditions.push(ne(calendarBookings.id, exclude.excludeBookingId));

      const [result] = await db
        .select({ total: count() })
        .from(calendarBookings)
        .where(and(...conditions));
      return Number(result?.total ?? 0);
    },
  };
}

/** The slots of `date` (`YYYY-MM-DD`, page timezone). Empty when the day offers none. */
export async function loadDaySlots(
  db: TenantQueryDb,
  row: SlotPageRow,
  date: string,
  exclude: SlotExclusions = {},
): Promise<Slot[]> {
  const page = toDaySlotsPage(row);
  if (!page) return [];
  return computeDaySlots(page, date, tenantSource(db, row, exclude));
}

/** True when the exact slot can still be booked, under the same rules as the picker. */
export async function isTenantSlotAvailable(
  db: TenantQueryDb,
  row: SlotPageRow,
  startIso: string,
  endIso: string,
  exclude: SlotExclusions = {},
): Promise<boolean> {
  const page = toDaySlotsPage(row);
  if (!page) return false;
  return isSlotStillAvailable(page, startIso, endIso, tenantSource(db, row, exclude));
}

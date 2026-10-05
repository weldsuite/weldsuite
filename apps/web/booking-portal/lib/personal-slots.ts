/**
 * Personal booking pages (`/p/{slug}`): the personal-database side of slot
 * availability. Same rules as workspace pages (`day-slots.ts`), minus the two
 * that the personal page table has no column for: date overrides and the
 * per-day booking cap.
 */

import { and, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  personalCalendarEvents,
  type PersonalCalendarBookingPage,
} from '@weldsuite/db/schema/personal';
import type * as personalSchema from '@weldsuite/db/schema/personal';

import { BLOCKING_EVENT_STATUSES, sanitizeAvailability, type Slot } from './availability';
import {
  EVENT_WITHOUT_END_MS,
  computeDaySlots,
  isSlotStillAvailable,
  type DaySlotsPage,
  type DaySlotsSource,
} from './day-slots';
import { weeklyAvailabilitySchema } from './schemas';

/** A personal database handle, or a transaction on one. */
export type PersonalQueryDb = PgDatabase<PgQueryResultHKT, typeof personalSchema>;

export type PersonalSlotPageRow = Pick<
  PersonalCalendarBookingPage,
  | 'id'
  | 'personalAccountId'
  | 'timezone'
  | 'availability'
  | 'duration'
  | 'bufferBefore'
  | 'bufferAfter'
  | 'minNotice'
  | 'maxAdvance'
>;

function toDaySlotsPage(row: PersonalSlotPageRow): DaySlotsPage | null {
  const weekly = weeklyAvailabilitySchema.safeParse(row.availability);
  if (!weekly.success) {
    console.error(
      '[booking-portal] personal availability JSONB failed schema validation',
      row.id,
      weekly.error.flatten(),
    );
    return null;
  }
  return {
    timezone: row.timezone || 'UTC',
    weekly: sanitizeAvailability(weekly.data),
    overrides: null,
    durationMinutes: row.duration,
    bufferBeforeMinutes: row.bufferBefore,
    bufferAfterMinutes: row.bufferAfter,
    minNoticeMinutes: row.minNotice,
    maxAdvanceDays: row.maxAdvance,
    maxBookingsPerDay: null,
  };
}

function personalSource(
  db: PersonalQueryDb,
  row: PersonalSlotPageRow,
  excludeEventId: string | null | undefined,
): DaySlotsSource {
  return {
    async busyEvents(from, to) {
      const conditions = [
        isNull(personalCalendarEvents.deletedAt),
        eq(personalCalendarEvents.personalAccountId, row.personalAccountId),
        inArray(personalCalendarEvents.status, [...BLOCKING_EVENT_STATUSES]),
        lt(personalCalendarEvents.startTime, to),
        or(
          gt(personalCalendarEvents.endTime, from),
          and(
            isNull(personalCalendarEvents.endTime),
            gt(personalCalendarEvents.startTime, new Date(from.getTime() - EVENT_WITHOUT_END_MS)),
          ),
        ),
      ];
      if (excludeEventId) conditions.push(ne(personalCalendarEvents.id, excludeEventId));

      return db
        .select({
          startTime: personalCalendarEvents.startTime,
          endTime: personalCalendarEvents.endTime,
          status: personalCalendarEvents.status,
        })
        .from(personalCalendarEvents)
        .where(and(...conditions));
    },

    // Personal pages have no per-day cap.
    bookingCount: () => Promise.resolve(0),
  };
}

export async function loadPersonalDaySlots(
  db: PersonalQueryDb,
  row: PersonalSlotPageRow,
  date: string,
  excludeEventId?: string | null,
): Promise<Slot[]> {
  const page = toDaySlotsPage(row);
  if (!page) return [];
  return computeDaySlots(page, date, personalSource(db, row, excludeEventId));
}

export async function isPersonalSlotAvailable(
  db: PersonalQueryDb,
  row: PersonalSlotPageRow,
  startIso: string,
  endIso: string,
  excludeEventId?: string | null,
): Promise<boolean> {
  const page = toDaySlotsPage(row);
  if (!page) return false;
  return isSlotStillAvailable(page, startIso, endIso, personalSource(db, row, excludeEventId));
}

/**
 * Booking-page slot availability for personal calendars.
 * Adapted from app-api's calendar-slots.ts — owner events live in personal_calendar_events.
 */

import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import type { PersonalDatabase } from '../db';
import { personalSchema } from '../db';

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface AvailabilityRange {
  start: string;
  end: string;
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
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function fromZonedTime(wallClock: string, timeZone: string): Date {
  const naive = Date.parse(`${wallClock}Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`Invalid wall-clock timestamp: ${wallClock}`);
  }
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
}

export function weekdayNameForDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date: ${date}`);
  return DAY_NAMES[new Date(parsed).getUTCDay()];
}

export interface BookingPageSlotConfig {
  personalAccountId: string;
  availability: WeeklyAvailability | null;
  timezone: string | null;
  duration: number;
  bufferBefore: number | null;
  bufferAfter: number | null;
  minNotice: number | null;
}

export async function computeAvailableSlots(
  db: PersonalDatabase,
  page: BookingPageSlotConfig,
  date: string,
): Promise<TimeSlot[]> {
  const { personalCalendarEvents } = personalSchema;

  const availability = page.availability ?? {};
  const tz = page.timezone || 'UTC';
  const daySlots = availability[weekdayNameForDate(date)] ?? [];
  if (daySlots.length === 0) return [];

  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${date}T23:59:59.999`, tz);

  const existingEvents = await db
    .select({ startTime: personalCalendarEvents.startTime, endTime: personalCalendarEvents.endTime })
    .from(personalCalendarEvents)
    .where(
      and(
        isNull(personalCalendarEvents.deletedAt),
        eq(personalCalendarEvents.personalAccountId, page.personalAccountId),
        gte(personalCalendarEvents.startTime, dayStart),
        lte(personalCalendarEvents.startTime, dayEnd),
        eq(personalCalendarEvents.status, 'confirmed'),
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

      const bufferedStart = slotStart.getTime() - bufferBefore * 60000;
      const bufferedEnd = slotEnd.getTime() + bufferAfter * 60000;

      const hasConflict = existingEvents.some((evt) => {
        const evtStart = new Date(evt.startTime).getTime();
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

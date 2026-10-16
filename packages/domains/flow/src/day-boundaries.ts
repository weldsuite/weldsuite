/**
 * Calendar-day boundaries in a time zone.
 *
 * A Worker's own clock is UTC, so `new Date('YYYY-MM-DDT00:00:00')` and
 * `Date.UTC(...)` both cut the day at UTC midnight. For a workspace in UTC+2 that
 * makes a task due "today" look overdue for the first two hours of the day and
 * shifts every due-today / overdue count. Everything that buckets a due date
 * (the task list filters, My Tasks, the daily digest) takes its day boundaries
 * from here instead, resolved in the workspace time zone
 * (`workspace_settings.timezone`).
 *
 * Pure date maths; the only database helper is `getWorkspaceTimezone`.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayBounds {
  /** Local midnight that starts today. A due date before it is overdue. */
  startOfToday: Date;
  /** Local midnight that ends today (starts tomorrow). */
  startOfTomorrow: Date;
  /**
   * The Monday after tomorrow's week-day: "this week" runs from tomorrow up to
   * (excluding) this instant. When today is Sunday that is the Monday 8 days out.
   */
  startOfNextWeek: Date;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds the zone is ahead of UTC at the given instant. */
function zoneOffsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  // The formatter has no milliseconds; the instant's own are part of the offset maths.
  return asUtc - (instant - (instant % 1000));
}

/** The instant of local midnight on the given calendar day (month is 1-based). */
function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  // Resolve twice so a day whose offset changes (DST) still lands on midnight.
  const first = naive - zoneOffsetMs(naive, timezone);
  return new Date(naive - zoneOffsetMs(first, timezone));
}

/** Today's calendar date (year, 1-based month, day) as read on a wall clock in the zone. */
function localCalendarDay(now: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: field('year'), month: field('month'), day: field('day') };
}

/**
 * Today / tomorrow / next-Monday boundaries in `timezone` (falls back to UTC for
 * a missing or unknown zone).
 */
export function dayBoundsInTimezone(timezone: string | null | undefined, now: Date = new Date()): DayBounds {
  const zone = timezone && isValidTimezone(timezone) ? timezone : 'UTC';
  const today = localCalendarDay(now, zone);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);

  const at = (offsetDays: number): Date => {
    const d = new Date(todayUtc + offsetDays * DAY_MS);
    return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), zone);
  };

  const tomorrowWeekday = new Date(todayUtc + DAY_MS).getUTCDay();
  const daysUntilNextMonday = (1 - tomorrowWeekday + 7) % 7 || 7;

  return {
    startOfToday: at(0),
    startOfTomorrow: at(1),
    startOfNextWeek: at(1 + daysUntilNextMonday),
  };
}

/** The workspace's configured time zone, or null when none is set. */
export async function getWorkspaceTimezone(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ timezone: schema.workspaceSettings.timezone })
    .from(schema.workspaceSettings)
    .limit(1);
  return row?.timezone || null;
}

/** Day boundaries in the workspace's time zone. */
export async function workspaceDayBounds(db: Database, now: Date = new Date()): Promise<DayBounds> {
  return dayBoundsInTimezone(await getWorkspaceTimezone(db), now);
}

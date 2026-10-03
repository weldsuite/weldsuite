/**
 * Pure helpers for a booking page's weekly availability.
 *
 * Kept free of imports so it can be unit-tested with the Node test runner
 * (`pnpm test`) and shared by server actions and client components.
 */

export interface AvailabilityRange {
  start: string;
  end: string;
}

export type WeeklyAvailabilityLike = Partial<Record<string, readonly AvailabilityRange[] | undefined>>;

export const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/** Minutes since midnight for "HH:MM", or null when malformed. */
export function minutesOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when the range ends after it starts. */
export function isValidRange(range: AvailabilityRange): boolean {
  const start = minutesOfDay(range.start);
  const end = minutesOfDay(range.end);
  return start !== null && end !== null && end > start;
}

/**
 * Drops ranges that can never produce a slot (end not after start). The editor
 * and the API reject them now, but pages saved earlier may still contain them.
 */
export function sanitizeAvailability(
  availability: WeeklyAvailabilityLike,
): Record<string, AvailabilityRange[]> {
  const cleaned: Record<string, AvailabilityRange[]> = {};
  for (const [day, ranges] of Object.entries(availability)) {
    if (ranges) cleaned[day] = ranges.filter(isValidRange).map((r) => ({ start: r.start, end: r.end }));
  }
  return cleaned;
}

/** True when at least one range is long enough to hold a `duration`-minute slot. */
export function hasBookableRange(
  ranges: readonly AvailabilityRange[] | undefined,
  durationMinutes: number,
): boolean {
  return (ranges ?? []).some((range) => {
    const start = minutesOfDay(range.start);
    const end = minutesOfDay(range.end);
    return start !== null && end !== null && end - start >= durationMinutes;
  });
}

/**
 * Weekday of a calendar date (`YYYY-MM-DD`). The date is already a calendar
 * date in the booking page's own timezone, so no timezone conversion applies
 * (converting UTC midnight into a negative-offset zone lands on the previous
 * day and picks the wrong weekday's availability).
 */
export function weekdayOfDate(date: string): WeekdayName | null {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return WEEKDAY_NAMES[new Date(parsed).getUTCDay()] ?? null;
}

/** Number of leading blanks in a Monday-first month grid (Mon = 0 ... Sun = 6). */
export function mondayFirstOffset(jsWeekday: number): number {
  return (jsWeekday + 6) % 7;
}

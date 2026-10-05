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

// ── Date overrides ─────────────────────────────────────────────────────────

/** Availability for one calendar date (`YYYY-MM-DD`, page timezone). */
export interface DateOverrideLike {
  date: string;
  slots: readonly AvailabilityRange[];
}

/**
 * The ranges that apply on a date. An override for that exact date REPLACES the
 * weekly availability (an override with no slots closes the day); without one
 * the weekday's ranges apply. Ranges that can never hold a slot are dropped.
 */
export function rangesForDate(
  date: string,
  weekly: WeeklyAvailabilityLike,
  overrides?: readonly DateOverrideLike[] | null,
): AvailabilityRange[] {
  const override = overrides?.find((o) => o.date === date);
  if (override) return override.slots.filter(isValidRange).map((r) => ({ start: r.start, end: r.end }));

  const weekday = weekdayOfDate(date);
  if (!weekday) return [];
  return (weekly[weekday] ?? []).filter(isValidRange).map((r) => ({ start: r.start, end: r.end }));
}

/** True when the ranges that apply on `date` include one long enough for an appointment. */
export function hasBookableDate(
  date: string,
  weekly: WeeklyAvailabilityLike,
  overrides: readonly DateOverrideLike[] | null | undefined,
  durationMinutes: number,
): boolean {
  return hasBookableRange(rangesForDate(date, weekly, overrides), durationMinutes);
}

// ── Booking window ─────────────────────────────────────────────────────────

/** Days ahead a page accepts bookings when it does not say (the column default). */
export const DEFAULT_MAX_ADVANCE_DAYS = 60;
/** Minutes of notice a page requires when it does not say (the column default). */
export const DEFAULT_MIN_NOTICE_MINUTES = 60;
/** Length assumed for a calendar event that has no end time. */
export const DEFAULT_EVENT_MINUTES = 30;

/** Event statuses that keep a slot taken. A cancelled event frees it. */
export const BLOCKING_EVENT_STATUSES = ['confirmed', 'tentative'] as const;

/** `date` (`YYYY-MM-DD`) moved by `days`, or null when `date` is malformed. */
export function addDaysToDate(date: string, days: number): string | null {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

/** The last date a page accepts bookings for, given today's date in the page timezone. */
export function lastBookableDate(
  todayInPageTz: string,
  maxAdvanceDays: number | null | undefined,
): string | null {
  return addDaysToDate(todayInPageTz, maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS);
}

/** True when `date` lies further ahead than the page's `maxAdvance` allows. */
export function isBeyondMaxAdvance(
  date: string,
  todayInPageTz: string,
  maxAdvanceDays: number | null | undefined,
): boolean {
  const last = lastBookableDate(todayInPageTz, maxAdvanceDays);
  // Both are `YYYY-MM-DD`, so string order is date order.
  return last !== null && date > last;
}

/** True when a slot starts sooner than the page's minimum notice allows. */
export function isInsideMinNotice(
  slotStart: Date,
  now: Date,
  minNoticeMinutes: number | null | undefined,
): boolean {
  const noticeMs = (minNoticeMinutes ?? DEFAULT_MIN_NOTICE_MINUTES) * 60_000;
  return slotStart.getTime() - now.getTime() < noticeMs;
}

/** True when `maxBookingsPerDay` is set (> 0) and `bookingsOnDay` has reached it. */
export function isDayFull(
  bookingsOnDay: number,
  maxBookingsPerDay: number | null | undefined,
): boolean {
  return !!maxBookingsPerDay && maxBookingsPerDay > 0 && bookingsOnDay >= maxBookingsPerDay;
}

// ── Slot generation ────────────────────────────────────────────────────────

export interface BusyEvent {
  startTime: Date | string;
  endTime: Date | string | null;
  /** Omitted when the caller already filtered by status. */
  status?: string | null;
}

/**
 * True when an event keeps the window [windowStart, windowEnd) busy: it overlaps
 * it, whether it starts on the same day or not (all-day and multi-day events
 * included). `confirmed` and `tentative` events block, `cancelled` ones do not.
 * An event without an end counts as 30 minutes long.
 */
export function eventBlocksWindow(event: BusyEvent, windowStart: Date, windowEnd: Date): boolean {
  if (event.status && !(BLOCKING_EVENT_STATUSES as readonly string[]).includes(event.status)) return false;
  const start = new Date(event.startTime).getTime();
  const end = event.endTime ? new Date(event.endTime).getTime() : start + DEFAULT_EVENT_MINUTES * 60_000;
  return start < windowEnd.getTime() && end > windowStart.getTime();
}

export interface Slot {
  /** ISO 8601 instant. */
  start: string;
  end: string;
  available: boolean;
}

export interface BuildSlotsInput {
  ranges: readonly AvailabilityRange[];
  durationMinutes: number;
  bufferBeforeMinutes?: number | null;
  bufferAfterMinutes?: number | null;
  minNoticeMinutes?: number | null;
  now: Date;
  busy: readonly BusyEvent[];
  /** True when the day already holds `maxBookingsPerDay` bookings: nothing is bookable. */
  dayFull?: boolean;
  /** The instant of a wall-clock "HH:mm" on the requested date, in the page timezone. */
  toInstant: (hhmm: string) => Date;
}

/**
 * Walks each range in `duration`-minute steps. A slot is unavailable when it
 * (widened by the buffers) overlaps a busy event, starts inside the minimum
 * notice, or the day is full. Buffers widen the slot for the conflict test only.
 */
export function buildSlots(input: BuildSlotsInput): Slot[] {
  const stepMs = input.durationMinutes * 60_000;
  if (!(stepMs > 0)) return [];
  const bufferBeforeMs = (input.bufferBeforeMinutes ?? 0) * 60_000;
  const bufferAfterMs = (input.bufferAfterMinutes ?? 0) * 60_000;
  const slots: Slot[] = [];
  const seen = new Set<number>();

  for (const range of input.ranges) {
    const rangeEnd = input.toInstant(range.end).getTime();
    for (let current = input.toInstant(range.start).getTime(); current + stepMs <= rangeEnd; current += stepMs) {
      // Overlapping ranges must not list the same start twice.
      if (seen.has(current)) continue;
      seen.add(current);

      const slotStart = new Date(current);
      const slotEnd = new Date(current + stepMs);
      const windowStart = new Date(current - bufferBeforeMs);
      const windowEnd = new Date(current + stepMs + bufferAfterMs);

      const blocked = input.busy.some((event) => eventBlocksWindow(event, windowStart, windowEnd));
      const tooSoon = isInsideMinNotice(slotStart, input.now, input.minNoticeMinutes);

      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        available: !input.dayFull && !blocked && !tooSoon,
      });
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * The slot that exactly matches the requested start and end, compared as
 * instants (not as strings, so `+00:00` and `Z` spellings are the same).
 */
export function findSlot(slots: readonly Slot[], startIso: string, endIso: string): Slot | undefined {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  return slots.find((s) => new Date(s.start).getTime() === start && new Date(s.end).getTime() === end);
}

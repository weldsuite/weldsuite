/**
 * Sending windows in a campaign's timezone.
 *
 * A campaign sends on certain ISO weekdays (1 = Monday .. 7 = Sunday) between
 * `windowStart` and `windowEnd` ("HH:MM", wall clock in the campaign's IANA
 * timezone). Everything here is pure and works on instants (`Date`), using
 * `Intl.DateTimeFormat` for the zone rules so daylight saving time is handled
 * by the runtime's tz database, never by fixed offsets.
 *
 * Conventions:
 * - the window is half-open, `[start, end)`;
 * - an `end` at or before `start` is treated as "until the end of the day";
 * - a wall-clock time that does not exist (spring-forward gap) resolves to the
 *   first instant after the gap, an ambiguous one (fall-back) to its first
 *   occurrence.
 */

export interface SendSchedule {
  timezone: string;
  /** ISO weekdays 1 (Mon) .. 7 (Sun). Empty means every day. */
  sendDays: readonly number[];
  /** "HH:MM" */
  windowStart: string;
  /** "HH:MM" */
  windowEnd: string;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 (Mon) .. 7 (Sun) */
  isoWeekday: number;
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
/** How far ahead `snapIntoWindow` looks for the next sending day. */
const MAX_LOOKAHEAD_DAYS = 14;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function isoWeekdayOf(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Wall-clock parts of an instant in `timeZone`. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  return {
    year,
    month,
    day,
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
    isoWeekday: isoWeekdayOf(year, month, day),
  };
}

/** `zone wall clock - UTC` at an instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const p = getZonedParts(new Date(whole), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** The instant at which `timeZone`'s wall clock reads `local`. */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0, local.second ?? 0);
  const firstOffset = zoneOffsetMs(asUtc, timeZone);
  let utc = asUtc - firstOffset;
  const secondOffset = zoneOffsetMs(utc, timeZone);
  if (secondOffset !== firstOffset) utc = asUtc - secondOffset;
  return new Date(utc);
}

/** `HH:MM` to minutes since midnight; null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function windowMinutes(schedule: SendSchedule): { start: number; end: number } {
  const start = parseHHMM(schedule.windowStart) ?? 9 * 60;
  const parsedEnd = parseHHMM(schedule.windowEnd) ?? 17 * 60;
  return { start, end: parsedEnd <= start ? DAY_MINUTES : parsedEnd };
}

function sendDaySet(schedule: SendSchedule): Set<number> {
  return schedule.sendDays.length > 0 ? new Set(schedule.sendDays) : new Set([1, 2, 3, 4, 5, 6, 7]);
}

/** Calendar date arithmetic on wall-clock dates (no zone involved). */
function shiftLocalDate(base: Pick<ZonedParts, 'year' | 'month' | 'day'>, days: number) {
  const d = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return { year, month, day, isoWeekday: isoWeekdayOf(year, month, day) };
}

function localMinutesToUtc(
  date: { year: number; month: number; day: number },
  minutes: number,
  timeZone: string,
): Date {
  if (minutes >= DAY_MINUTES) {
    const next = shiftLocalDate(date, 1);
    return zonedTimeToUtc({ year: next.year, month: next.month, day: next.day }, timeZone);
  }
  return zonedTimeToUtc(
    { year: date.year, month: date.month, day: date.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    timeZone,
  );
}

/** Midnight (start of the wall-clock day) containing `date`. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

/** Midnight that ends the wall-clock day containing `date`. */
export function startOfNextZonedDay(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  const next = shiftLocalDate(p, 1);
  return zonedTimeToUtc({ year: next.year, month: next.month, day: next.day }, timeZone);
}

/**
 * The earliest instant at or after `at` that lies inside a sending window.
 * Returns `at` itself when it is already inside one.
 */
export function snapIntoWindow(at: Date, schedule: SendSchedule): Date {
  const { start, end } = windowMinutes(schedule);
  const days = sendDaySet(schedule);
  const local = getZonedParts(at, schedule.timezone);

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    const day = shiftLocalDate(local, offset);
    if (!days.has(day.isoWeekday)) continue;
    const windowOpen = localMinutesToUtc(day, start, schedule.timezone);
    const windowClose = localMinutesToUtc(day, end, schedule.timezone);
    if (at.getTime() >= windowClose.getTime()) continue;
    return at.getTime() > windowOpen.getTime() ? at : windowOpen;
  }
  return at;
}

export function isWithinWindow(at: Date, schedule: SendSchedule): boolean {
  return snapIntoWindow(at, schedule).getTime() === at.getTime();
}

/** When the window of the wall-clock day containing `at` closes. */
export function windowCloseOfDay(at: Date, schedule: SendSchedule): Date {
  const { end } = windowMinutes(schedule);
  const local = getZonedParts(at, schedule.timezone);
  return localMinutesToUtc(local, end, schedule.timezone);
}

/**
 * Send times for `count` prospects launched at `from`: spread over what is left
 * of the first sending window (never sparser than `maxStepMs` apart), each
 * snapped into a window. Prospects that do not fit pile up at the next window
 * start; the per-mailbox caps do the rest at send time.
 */
export function spreadSendTimes(count: number, from: Date, schedule: SendSchedule, maxStepMs: number): Date[] {
  if (count <= 0) return [];
  const first = snapIntoWindow(from, schedule);
  const remaining = Math.max(windowCloseOfDay(first, schedule).getTime() - first.getTime(), 0);
  const step = count > 1 ? Math.max(0, Math.floor(Math.min(remaining / count, maxStepMs))) : 0;
  return Array.from({ length: count }, (_, i) => snapIntoWindow(new Date(first.getTime() + i * step), schedule));
}

/** `base` plus whole minutes. */
export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MINUTE_MS);
}

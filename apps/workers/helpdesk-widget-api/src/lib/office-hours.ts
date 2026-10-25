/**
 * Office hours: is the team in right now, and if not, when are they back?
 *
 * Windows are wall-clock times in the widget's IANA timezone. The widget
 * gets the answer from /api/config instead of the schedule, so visitors'
 * own clocks and timezones never come into it.
 */

import type { DeskOfficeHours, DeskWeekday } from '@weldsuite/db/schema/desk-widget-settings';

/** Indexed like Date#getDay(): Sunday first. */
const WEEKDAYS: DeskWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;

export interface OfficeHoursAvailability {
  /** True inside a window, and always when office hours are off. */
  isOpen: boolean;
  /** Start of the next window (ISO), when closed and one exists within a week. */
  nextOpenAt: string | null;
}

function minutesOf(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total <= DAY_MINUTES ? total : null;
}

export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Weekday (0 = Sunday) and minutes since midnight at `at`, in `timeZone`. */
function localClock(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(part('hour')) % 24;
  return { day: SHORT_WEEKDAYS.indexOf(part('weekday')), minutes: hour * 60 + Number(part('minute')) };
}

function windowOn(officeHours: DeskOfficeHours, day: number): { start: number; end: number } | null {
  const window = officeHours.days?.[WEEKDAYS[day]];
  if (!window) return null;
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export function officeHoursAvailability(
  officeHours: DeskOfficeHours | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): OfficeHoursAvailability {
  if (!officeHours?.enabled) return { isOpen: true, nextOpenAt: null };
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const nowMinute = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
  const { day, minutes } = localClock(nowMinute, zone);

  const today = windowOn(officeHours, day);
  if (today && minutes >= today.start && minutes < today.end) return { isOpen: true, nextOpenAt: null };

  // Today's later window first, then the coming days, up to the same weekday next week.
  for (let offset = 0; offset <= 7; offset++) {
    const window = windowOn(officeHours, (day + offset) % 7);
    if (!window || (offset === 0 && window.start <= minutes)) continue;
    const guess = new Date(nowMinute.getTime() + (offset * DAY_MINUTES + window.start - minutes) * MINUTE_MS);
    // A DST change in between shifts the wall clock by up to an hour: correct once.
    let drift = window.start - localClock(guess, zone).minutes;
    if (drift > DAY_MINUTES / 2) drift -= DAY_MINUTES;
    if (drift < -DAY_MINUTES / 2) drift += DAY_MINUTES;
    return { isOpen: false, nextOpenAt: new Date(guess.getTime() + drift * MINUTE_MS).toISOString() };
  }
  return { isOpen: false, nextOpenAt: null };
}

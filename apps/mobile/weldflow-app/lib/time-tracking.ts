/**
 * Time-tracking helpers: elapsed-time and duration formatting, the calendar
 * week a timesheet shows, and grouping entries by day.
 *
 * Calendar days are local `YYYY-MM-DD` strings, the same shape the server
 * stores in `project_time_entries.date`.
 */

import type { TimeEntry } from '@/types/weldflow';

/** Longest single entry the "Log time" form accepts: one full day. */
export const MAX_LOGGED_MINUTES = 24 * 60;

/** Local calendar day of `date` as `YYYY-MM-DD`. */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` back to a local Date at midnight. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Adds `days` (may be negative) to a calendar day. */
export function addDays(key: string, days: number): string {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** Monday-to-Sunday week containing `date`, as calendar days. */
export function weekRange(date: Date): { from: string; to: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): Sunday 0 … Saturday 6. Monday starts the week.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  const from = toDateKey(start);
  return { from, to: addDays(from, 6) };
}

/** Running time as a clock: "4:07" under an hour, "1:04:07" from one hour on. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

/** Milliseconds a timer has run at `now`. Never negative (clock skew). */
export function elapsedMs(startedAt: string, now: number): number {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, now - started);
}

/** Whole hours and the remaining minutes of a duration, rounded to the minute. */
export function splitMinutes(minutes: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** An entry's duration in minutes (the API sends a numeric string). */
export function entryMinutes(entry: Pick<TimeEntry, 'duration'>): number {
  const value = Number(entry.duration);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Minutes from the "Log time" form's hour and minute fields, or null when the
 * input is not a positive whole duration of at most one day.
 */
export function parseLoggedMinutes(hours: string, minutes: string): number | null {
  const h = hours.trim() === '' ? 0 : Number(hours.trim());
  const m = minutes.trim() === '' ? 0 : Number(minutes.trim());
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) return null;
  const total = h * 60 + m;
  if (total <= 0 || total > MAX_LOGGED_MINUTES) return null;
  return total;
}

export interface TimeEntryDay {
  date: string;
  minutes: number;
  entries: TimeEntry[];
}

/** Entries grouped per calendar day, newest day first, each with its total. */
export function groupEntriesByDay(entries: readonly TimeEntry[]): TimeEntryDay[] {
  const days = new Map<string, TimeEntryDay>();
  for (const entry of entries) {
    const key = entry.date.slice(0, 10);
    let day = days.get(key);
    if (!day) {
      day = { date: key, minutes: 0, entries: [] };
      days.set(key, day);
    }
    day.minutes += entryMinutes(entry);
    day.entries.push(entry);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** The device's IANA time zone, or undefined when Intl can't tell. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

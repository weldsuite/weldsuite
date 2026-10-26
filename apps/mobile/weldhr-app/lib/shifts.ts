/**
 * Shifts and the hours clocked on them: which record belongs to which shift,
 * how long a shift is without its break, the breaks taken in between, and
 * what the hours earn. Shared by Schedule and the shift page.
 */

import { dayOf } from './dates';
import { formatMoney } from './format';

/** What pairing needs from a clock record, mine or a teammate's. */
export interface Clocked {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  shiftId?: string | null;
}

/** What pairing needs from a shift, mine or a teammate's. */
export interface Planned {
  id: string;
  startsAt: string;
  endsAt: string;
  breakStartsAt?: string | null;
  breakEndsAt?: string | null;
}

/** A stretch of time, as ISO timestamps. */
export interface Span {
  start: string;
  end: string;
}

/** The currency for "€ 0,00" when nothing carries one (no pay set up in payroll). */
export const DEFAULT_CURRENCY = 'EUR';

const time = (iso: string) => new Date(iso).getTime();

export const isOpen = (record: Clocked) => Boolean(record.clockIn && !record.clockOut);

export const byClockIn = (a: Clocked, b: Clocked) => (a.clockIn ?? '').localeCompare(b.clockIn ?? '');

/** Whole minutes between two timestamps. */
export function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((time(end) - time(start)) / 60_000));
}

/** A record's minutes: what it worked, or so far for one still running. */
export function minutesOf(record: Clocked, now: number): number {
  if (record.workedMinutes != null) return record.workedMinutes;
  if (record.clockIn && !record.clockOut) return Math.max(0, (now - time(record.clockIn)) / 60_000);
  return 0;
}

/** A shift's planned break, when it has one. */
export function plannedBreak(shift: Planned): Span | null {
  return shift.breakStartsAt && shift.breakEndsAt ? { start: shift.breakStartsAt, end: shift.breakEndsAt } : null;
}

/** A shift's planned minutes, its break left out (breaks are unpaid). */
export function plannedMinutes(shift: Planned): number {
  const pause = plannedBreak(shift);
  return Math.max(0, minutesBetween(shift.startsAt, shift.endsAt) - (pause ? minutesBetween(pause.start, pause.end) : 0));
}

/**
 * The shift a record was clocked on: the one it is linked to, or else one
 * that day its hours overlap (records from before the link was stored).
 * `shifts` are the same person's.
 */
export function shiftOf<S extends Planned>(record: Clocked, shifts: S[], now: number): S | undefined {
  if (record.shiftId) return shifts.find((shift) => shift.id === record.shiftId);
  if (!record.clockIn) return undefined;
  const start = time(record.clockIn);
  const end = record.clockOut ? time(record.clockOut) : now;
  return shifts.find(
    (shift) => dayOf(shift.startsAt) === record.date && time(shift.startsAt) < end && time(shift.endsAt) > start,
  );
}

/**
 * The gaps between one clocked stretch and the next: clocking out for a break
 * and back in. Under a minute is a slip of the finger, not a break.
 */
export function clockedOutGaps(records: Clocked[]): Span[] {
  const stretches = records.filter((r) => r.clockIn).sort(byClockIn);
  const gaps: Span[] = [];
  for (let i = 1; i < stretches.length; i++) {
    const before = stretches[i - 1]?.clockOut;
    const after = stretches[i]?.clockIn;
    if (before && after && minutesBetween(before, after) >= 1) gaps.push({ start: before, end: after });
  }
  return gaps;
}

interface Paid extends Clocked {
  hourlyRate?: number | null;
  currency?: string | null;
}

/**
 * What `records` earn at their own hourly rates ("€ 7,40"), per currency.
 * Hours without a rate earn nothing, so with no pay set up it is € 0,00.
 */
export function earnings(records: Paid[], now: number, fallback: string, locale: string): string {
  const sums = new Map<string, number>();
  for (const record of records) {
    if (record.hourlyRate == null || !record.currency) continue;
    sums.set(record.currency, (sums.get(record.currency) ?? 0) + (minutesOf(record, now) / 60) * record.hourlyRate);
  }
  if (sums.size === 0) sums.set(fallback, 0);
  return [...sums].map(([currency, amount]) => formatMoney(amount, currency, locale)).join(' · ');
}

/**
 * Small date helpers on `YYYY-MM-DD` strings (UTC). The shared HR helpers
 * (`../shared`) have `addDays`/`todayIso`; this file re-exports what the payroll
 * services need so they import from one place, and adds the range arithmetic.
 */

import { addDays as addDaysShared, todayIso as todayIsoShared } from '../shared';

export const addDays = addDaysShared;
export const todayIso = todayIsoShared;

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** True when [aStart, aEnd] and [bStart, bEnd] share a day. `null` end = open-ended. */
export function rangesOverlap(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null): boolean {
  const aLast = aEnd ?? '9999-12-31';
  const bLast = bEnd ?? '9999-12-31';
  return aStart <= bLast && bStart <= aLast;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Whole years between a date of birth and a reference day. */
export function ageOnDate(dateOfBirth: string, onDate: string): number {
  const born = new Date(`${dateOfBirth}T00:00:00Z`);
  const on = new Date(`${onDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - born.getUTCFullYear();
  const before = on.getUTCMonth() < born.getUTCMonth() || (on.getUTCMonth() === born.getUTCMonth() && on.getUTCDate() < born.getUTCDate());
  if (before) age -= 1;
  return age;
}

/**
 * Open shifts: shifts HR posts for anyone to take. An employee signs up, a
 * manager picks who gets it. These helpers order the list and say where
 * each one stands for the signed-in employee; the words come from the catalog.
 */

import type { HrShiftRequestStatus } from '@weldsuite/app-api-client/domains/weldhr';

/** What the list needs from an open shift (`HrSelfOpenShift`). */
export interface Posted {
  id: string;
  startsAt: string;
  endsAt: string;
  spotsLeft: number;
  myRequest: { id: string; status: HrShiftRequestStatus; reviewNote: string | null } | null;
}

/**
 * Where an open shift stands for me:
 * - `open`: I can sign up
 * - `waiting`: I signed up, a manager has not answered
 * - `declined`: my sign-up was turned down (or the shift filled up first)
 * - `full`: no spot left and I am not in it
 */
export type OpenShiftStanding = 'open' | 'waiting' | 'declined' | 'full';

export function standingOf(shift: Posted): OpenShiftStanding {
  const status = shift.myRequest?.status;
  if (status === 'pending') return 'waiting';
  if (status === 'rejected') return 'declined';
  // A withdrawn sign-up (`cancelled`) is as good as none; an approved one is a shift in my schedule.
  return shift.spotsLeft > 0 ? 'open' : 'full';
}

/** Whether I can sign up for it now: a spot left, and no sign-up waiting (a declined or withdrawn one may be tried again). */
export function canSignUp(shift: Posted, now: number = Date.now()): boolean {
  return new Date(shift.startsAt).getTime() > now && shift.spotsLeft > 0 && shift.myRequest?.status !== 'pending';
}

/**
 * What to list: shifts that have not started, soonest first. Shifts that are
 * full are left out unless my sign-up is waiting or was declined, so I still
 * see its answer.
 * One I already got (approved) is a shift in my schedule, not an open one.
 */
export function listableOpenShifts<T extends Posted>(shifts: T[], now: number = Date.now()): T[] {
  return shifts
    .filter((shift) => new Date(shift.startsAt).getTime() > now)
    .filter((shift) => shift.myRequest?.status !== 'approved')
    .filter((shift) => shift.spotsLeft > 0 || standingOf(shift) === 'waiting' || standingOf(shift) === 'declined')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

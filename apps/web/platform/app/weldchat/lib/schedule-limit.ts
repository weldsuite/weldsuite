/**
 * Scheduling a forward is an in-memory `setTimeout` (nothing is persisted
 * server-side). `setTimeout` keeps its delay in a signed 32-bit integer, so a
 * delay above ~24.8 days overflows and fires IMMEDIATELY instead of later.
 * Stay safely below that, at a whole number of days.
 */
export const MAX_SCHEDULE_DAYS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ScheduleCheck = 'ok' | 'past' | 'too-far';

export function checkScheduleTime(when: Date, now: number = Date.now()): ScheduleCheck {
  const delay = when.getTime() - now;
  if (delay <= 0) return 'past';
  if (delay > MAX_SCHEDULE_DAYS * DAY_MS) return 'too-far';
  return 'ok';
}

/** Latest day the schedule calendar should offer. */
export function latestScheduleDate(now: number = Date.now()): Date {
  return new Date(now + MAX_SCHEDULE_DAYS * DAY_MS);
}

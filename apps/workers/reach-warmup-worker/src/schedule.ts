/**
 * How many warmup messages a mailbox gets today and when they go out.
 *
 * Pure. The target comes from the ramp (warming) or a random value in the
 * maintenance range (maintaining); the sends are spread over what is left of
 * the mailbox's business hours (09:00-17:30 local, Monday to Friday) with
 * random gaps.
 */

import {
  WARMUP_MAINTAIN_MAX,
  WARMUP_MAINTAIN_MIN,
  warmupRampTarget,
} from '@weldsuite/reach-domain/warmup';
import { MINUTE_MS, randomInt, type Rng } from './lib/random';
import type { BusinessWindow } from './lib/time';

/** Nothing is scheduled sooner than this after planning: the dispatcher needs a tick to pick it up. */
export const PLANNING_LEAD_MS = 2 * MINUTE_MS;
/** Sends of one mailbox are never closer than this. */
export const MIN_GAP_MS = 45_000;

/**
 * Warmup emails a mailbox sends per thread it starts, counting the replies it
 * sends to other mailboxes' threads: replies come on 30-45% of threads and
 * later steps continue about half the time, which lands near 1.6 across the pool.
 */
export const SENDS_PER_THREAD = 1.6;

/** New threads to start so that, with the replies on top, total warmup sends stay near `totalSends`. */
export function newThreadsFor(totalSends: number): number {
  if (totalSends <= 0) return 0;
  return Math.max(1, Math.round(totalSends / SENDS_PER_THREAD));
}

/**
 * New threads a mailbox starts today, before the business-hours adjustment. The
 * ramp (2 → 40) and the maintenance range (10–15) are total sends per day.
 */
export function dailyTargetFor(status: 'warming' | 'maintaining', rampDay: number, rng: Rng): number {
  if (status === 'maintaining') return newThreadsFor(randomInt(rng, WARMUP_MAINTAIN_MIN, WARMUP_MAINTAIN_MAX));
  return newThreadsFor(warmupRampTarget(rampDay));
}

export interface DayPlan {
  /** Messages to schedule today (0 on weekends and once the day is over). */
  count: number;
  /** First moment a message may go out. */
  from: Date;
  /** Business hours end. */
  until: Date;
}

/**
 * Today's plan for one mailbox. Weekends plan nothing: warmup mimics a working
 * mailbox, and Saturday/Sunday traffic would stand out. When the planner runs
 * mid-day (a new mailbox, a late cron) only the remaining share of the target
 * is planned.
 */
export function planDay(target: number, window: BusinessWindow, now: Date): DayPlan {
  const from = new Date(Math.max(now.getTime() + PLANNING_LEAD_MS, window.start.getTime()));
  const empty: DayPlan = { count: 0, from, until: window.end };
  if (!window.businessDay || target <= 0 || from >= window.end) return empty;

  const fullMs = window.end.getTime() - window.start.getTime();
  const share = Math.min(1, (window.end.getTime() - from.getTime()) / fullMs);
  const fits = Math.floor((window.end.getTime() - from.getTime()) / MIN_GAP_MS);
  return { count: Math.min(Math.round(target * share), fits), from, until: window.end };
}

/**
 * `count` send times over [from, until]: the span is cut into equal slots and
 * each message lands at a random point of its slot, so the day is covered
 * evenly without a regular beat. Times are sorted and at least MIN_GAP_MS apart.
 */
export function spreadTimes(from: Date, until: Date, count: number, rng: Rng): Date[] {
  if (count <= 0) return [];
  const start = from.getTime();
  const end = until.getTime();
  const slot = (end - start) / count;
  const times: Date[] = [];
  let previous = start - MIN_GAP_MS;
  for (let i = 0; i < count; i++) {
    const at = Math.min(Math.max(start + slot * (i + rng()), previous + MIN_GAP_MS), end);
    times.push(new Date(at));
    previous = at;
  }
  return times;
}

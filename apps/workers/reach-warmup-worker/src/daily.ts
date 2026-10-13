/**
 * Daily (cron, 02:30 UTC): ramp, stats, auto-pause, cleanup, corpus refresh.
 *
 *   1. Ramp. A warming / maintaining mailbox that actually sent warmup mail
 *      yesterday (UTC day) moves one ramp day on; a mailbox that sent nothing
 *      (a weekend, an outage) stays where it is, so the ramp counts days of
 *      real warmup sending. Warming mailboxes with WARMUP_MIN_DAYS days become
 *      `maintaining`. Guarded by `ramp_updated_at`, so a second run the same
 *      UTC day advances nobody twice.
 *   2. Stats rollup per pool mailbox (stats.ts).
 *   3. Auto-pause: a maintaining mailbox whose inbox rate over 3 days fell
 *      below AUTO_PAUSE_INBOX_RATE (with enough judged mail) is paused with
 *      `low_inbox_rate`; reach-api shows it. Such a pause is lifted by this job
 *      after LOW_RATE_COOL_OFF_DAYS (nothing is sent meanwhile, so the rate
 *      cannot recover on its own) and the mailbox is measured again; a pause
 *      with any other reason is never touched.
 *   4. Cleanup of old warmup mail (cleanup.ts) and of old message rows.
 *   5. The corpus refresh (no-op unless it is due).
 *
 * Each step is independent: one failing is logged and the others still run.
 */

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { WARMUP_GATE_WINDOW_DAYS, WARMUP_MIN_DAYS } from '@weldsuite/reach-domain/warmup';
import { unpausedStatus } from '@weldsuite/reach-domain/warmup-pool';
import type { Env } from './env';
import { runCleanup, type CleanupResult } from './cleanup';
import { refreshCorpus } from './corpus';
import { messages, openMaster, pool, type JobDeps, type MasterDatabase } from './lib/db';
import { isWarmupEnabled } from './lib/flag';
import { LOW_INBOX_RATE_REASON, markReachDue, type IndexEnv } from './lib/pool-state';
import { DAY_MS } from './lib/random';
import { rollUpStats, type RolledUpMailbox } from './stats';

/** A maintaining mailbox below this inbox rate over 3 days is paused. */
export const AUTO_PAUSE_INBOX_RATE = 0.6;
/** A paused mailbox is probed again after this long: the 3-day placement window has then drained. */
export const LOW_RATE_COOL_OFF_DAYS = WARMUP_GATE_WINDOW_DAYS;

export interface DailyResult {
  status: 'disabled' | 'ok';
  advanced: number;
  graduated: number;
  rolledUp: number;
  autoPaused: string[];
  resumed: string[];
  cleanup: CleanupResult | null;
  corpusRefreshed: boolean;
}

/** 00:00 UTC of the day `now` falls on. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Ramp day +1 for mailboxes that sent yesterday (UTC); warming -> maintaining at WARMUP_MIN_DAYS. */
export async function advanceRamp(
  master: MasterDatabase,
  now: Date,
): Promise<{ advanced: number; graduated: number }> {
  const today = startOfUtcDay(now);
  const yesterday = new Date(today.getTime() - DAY_MS);
  const sentYesterday = master
    .select({ id: messages.fromMailboxId })
    .from(messages)
    .where(and(gte(messages.sentAt, yesterday), lt(messages.sentAt, today)));

  const advanced = await master
    .update(pool)
    .set({ rampDay: sql`${pool.rampDay} + 1`, rampUpdatedAt: now, updatedAt: now })
    .where(
      and(
        inArray(pool.status, ['warming', 'maintaining']),
        or(isNull(pool.rampUpdatedAt), lt(pool.rampUpdatedAt, today)),
        inArray(pool.id, sentYesterday),
      ),
    )
    .returning({ id: pool.id });

  const graduated = await master
    .update(pool)
    .set({ status: 'maintaining', updatedAt: now })
    .where(and(eq(pool.status, 'warming'), gte(pool.rampDay, WARMUP_MIN_DAYS)))
    .returning({ id: pool.id });
  return { advanced: advanced.length, graduated: graduated.length };
}

/** Pause maintaining mailboxes whose placement dropped. Returns their ids. */
export async function pauseOnLowPlacement(
  env: IndexEnv,
  master: MasterDatabase,
  rolled: readonly RolledUpMailbox[],
  now: Date,
): Promise<string[]> {
  const low = rolled
    .filter(
      (mailbox) =>
        mailbox.status === 'maintaining' &&
        mailbox.stats.inboxRate3d !== null &&
        mailbox.stats.inboxRate3d < AUTO_PAUSE_INBOX_RATE,
    )
    .map((mailbox) => mailbox.id);
  if (low.length === 0) return [];
  const paused = await master
    .update(pool)
    .set({ status: 'paused', pausedReason: LOW_INBOX_RATE_REASON, updatedAt: now })
    .where(and(inArray(pool.id, low), eq(pool.status, 'maintaining')))
    .returning({ id: pool.id, email: pool.email, clerkOrgId: pool.clerkOrgId });
  for (const mailbox of paused) {
    console.warn(`[reach-warmup] daily: paused ${mailbox.id} (${mailbox.email}): ${LOW_INBOX_RATE_REASON}`);
    await markReachDue(env, mailbox.clerkOrgId, now);
  }
  return paused.map((mailbox) => mailbox.id);
}

/**
 * Lift our own low-placement pauses after the cool-off. A paused mailbox sends
 * and receives nothing, so its placement cannot recover while it is paused; after
 * LOW_RATE_COOL_OFF_DAYS it goes back to where its warmup had got to and is
 * measured again (it is paused again if the rate is still low). Pauses with any
 * other reason (customer, staff, suspended mailbox or domain) are never touched.
 */
export async function resumeAfterCoolOff(env: IndexEnv, master: MasterDatabase, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - LOW_RATE_COOL_OFF_DAYS * DAY_MS);
  const waiting = await master
    .select({ id: pool.id, clerkOrgId: pool.clerkOrgId, startedAt: pool.startedAt, rampDay: pool.rampDay })
    .from(pool)
    .where(and(eq(pool.status, 'paused'), eq(pool.pausedReason, LOW_INBOX_RATE_REASON), lt(pool.updatedAt, cutoff)));
  const resumed: string[] = [];
  for (const mailbox of waiting) {
    const lifted = await master
      .update(pool)
      .set({ status: unpausedStatus(mailbox), pausedReason: null, updatedAt: now })
      .where(and(eq(pool.id, mailbox.id), eq(pool.status, 'paused'), eq(pool.pausedReason, LOW_INBOX_RATE_REASON)))
      .returning({ id: pool.id });
    if (lifted.length === 0) continue;
    resumed.push(mailbox.id);
    await markReachDue(env, mailbox.clerkOrgId, now);
  }
  return resumed;
}

/** Run one step; a failure is logged and yields `fallback`. */
async function step<T>(name: string, fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    console.error(`[reach-warmup] daily: ${name} failed:`, err);
    return fallback;
  }
}

export async function runDailyTick(env: Env, deps: JobDeps = {}): Promise<DailyResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!(await isWarmupEnabled(env, now))) {
    return { status: 'disabled', advanced: 0, graduated: 0, rolledUp: 0, autoPaused: [], resumed: [], cleanup: null, corpusRefreshed: false };
  }
  const master = openMaster(env, deps);

  const ramp = await step('ramp', { advanced: 0, graduated: 0 }, () => advanceRamp(master, now));
  const rolled = await step('stats rollup', [] as RolledUpMailbox[], () => rollUpStats(master, now));
  const autoPaused = await step('auto-pause', [] as string[], () => pauseOnLowPlacement(env, master, rolled, now));
  const resumed = await step('cool-off resume', [] as string[], () => resumeAfterCoolOff(env, master, now));
  const cleanup = await step<CleanupResult | null>('cleanup', null, () => runCleanup(env, master, now));
  const corpusRefreshed = await step('corpus refresh', false, async () => (await refreshCorpus(env, now)).refreshed);

  console.log(
    `[reach-warmup] daily: ramp+${ramp.advanced} graduated=${ramp.graduated} rolledUp=${rolled.length} autoPaused=${autoPaused.length} resumed=${resumed.length} cleaned=${cleanup?.cleaned ?? 0} rowsDeleted=${cleanup?.rowsDeleted ?? 0} corpusRefreshed=${corpusRefreshed}`,
  );
  return {
    status: 'ok',
    advanced: ramp.advanced,
    graduated: ramp.graduated,
    rolledUp: rolled.length,
    autoPaused,
    resumed,
    cleanup,
    corpusRefreshed,
  };
}

/** Cron entry point (index.ts). The tick returns what it did, for tests. */
export async function runDaily(env: Env, deps: JobDeps = {}): Promise<void> {
  await runDailyTick(env, deps);
}

/**
 * Dispatch (cron, every minute): hands due work to the queues.
 *
 *   - scheduled messages whose time has come -> `reach-warmup-send`
 *   - sent messages whose engagement time has come -> `reach-warmup-engage`
 *
 * Rows are claimed with a conditional UPDATE (`claimed_at` = now where it is
 * unset or older than CLAIM_TTL_MS), so overlapping runs never hand out a row
 * twice and a lost queue message is picked up again after the claim expires.
 * Messages that are hours overdue (an outage, the kill switch) are failed
 * instead of sent late, so switching back on does not release a burst.
 */

import { and, asc, eq, inArray, isNull, lt, lte, or, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Env, WarmupEngageMessage, WarmupSendMessage } from './env';
import { CLAIM_TTL_MS, messages, openMaster, type JobDeps, type MasterDatabase } from './lib/db';
import { isWarmupEnabled } from './lib/flag';
import { HOUR_MS } from './lib/random';

/** Rows claimed per kind per tick. */
export const CLAIM_LIMIT = 200;
/** Queue `sendBatch` accepts at most 100 messages. */
export const QUEUE_BATCH_SIZE = 100;
/** A scheduled message this far past its time is dropped, not sent. */
export const STALE_SEND_AFTER_MS = 6 * HOUR_MS;
/** An engagement is attempted at most this many times. */
export const MAX_ENGAGE_ATTEMPTS = 3;

export interface DispatchResult {
  status: 'disabled' | 'ok';
  expired: number;
  sendQueued: number;
  engageQueued: number;
}

function notClaimed(now: Date) {
  return or(isNull(messages.claimedAt), lt(messages.claimedAt, new Date(now.getTime() - CLAIM_TTL_MS)));
}

/** Failed rather than sent hours late. */
async function expireStale(master: MasterDatabase, now: Date): Promise<number> {
  const expired = await master
    .update(messages)
    .set({ status: 'failed', error: 'expired', claimedAt: null })
    .where(and(eq(messages.status, 'scheduled'), lt(messages.scheduledAt, new Date(now.getTime() - STALE_SEND_AFTER_MS))))
    .returning({ id: messages.id });
  return expired.length;
}

/**
 * Claim up to `limit` of the rows matching `due`, oldest first, by setting
 * `claimed_at`. The ids are read first and the UPDATE repeats the conditions, so
 * of two overlapping runs that read the same ids, only the one whose UPDATE
 * reaches a row first changes it (the other no longer sees it as unclaimed).
 * (A single UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)
 * is not used: Postgres may re-run that subquery per row and claim more than n.)
 */
async function claimRows(
  master: MasterDatabase,
  due: SQL | undefined,
  order: AnyColumn,
  now: Date,
  limit: number,
): Promise<string[]> {
  const candidates = await master.select({ id: messages.id }).from(messages).where(due).orderBy(asc(order)).limit(limit);
  if (candidates.length === 0) return [];
  const claimed = await master
    .update(messages)
    .set({ claimedAt: now })
    .where(
      and(
        inArray(
          messages.id,
          candidates.map((row) => row.id),
        ),
        due,
      ),
    )
    .returning({ id: messages.id });
  const won = new Set(claimed.map((row) => row.id));
  return candidates.map((row) => row.id).filter((id) => won.has(id));
}

export async function claimDueSends(master: MasterDatabase, now: Date, limit = CLAIM_LIMIT): Promise<string[]> {
  const due = and(eq(messages.status, 'scheduled'), lte(messages.scheduledAt, now), notClaimed(now));
  return claimRows(master, due, messages.scheduledAt, now, limit);
}

export async function claimDueEngagements(master: MasterDatabase, now: Date, limit = CLAIM_LIMIT): Promise<string[]> {
  const due = and(
    eq(messages.status, 'sent'),
    lte(messages.engageAt, now),
    lt(messages.engageAttempts, MAX_ENGAGE_ATTEMPTS),
    notClaimed(now),
  );
  return claimRows(master, due, messages.engageAt, now, limit);
}

/** Give claimed rows back (the queue refused them), so the next tick can try again. */
async function releaseClaims(master: MasterDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await master.update(messages).set({ claimedAt: null }).where(inArray(messages.id, ids));
}

async function enqueue(
  master: MasterDatabase,
  queue: Queue<WarmupSendMessage> | Queue<WarmupEngageMessage>,
  ids: string[],
  label: string,
): Promise<number> {
  let queued = 0;
  for (let i = 0; i < ids.length; i += QUEUE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + QUEUE_BATCH_SIZE);
    try {
      await queue.sendBatch(chunk.map((messageId) => ({ body: { messageId } })));
      queued += chunk.length;
    } catch (err) {
      console.error(`[reach-warmup] dispatch: ${label} queue refused ${chunk.length} message(s):`, err);
      await releaseClaims(master, chunk).catch(() => undefined);
    }
  }
  return queued;
}

export async function runDispatchTick(env: Env, deps: JobDeps = {}): Promise<DispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!(await isWarmupEnabled(env, now))) return { status: 'disabled', expired: 0, sendQueued: 0, engageQueued: 0 };

  const master = openMaster(env, deps);
  const expired = await expireStale(master, now);

  let sendQueued = 0;
  if (env.WARMUP_SEND_QUEUE) {
    sendQueued = await enqueue(master, env.WARMUP_SEND_QUEUE, await claimDueSends(master, now), 'send');
  } else {
    console.warn('[reach-warmup] dispatch: WARMUP_SEND_QUEUE is not bound; sends are not dispatched');
  }

  let engageQueued = 0;
  if (env.WARMUP_ENGAGE_QUEUE) {
    engageQueued = await enqueue(master, env.WARMUP_ENGAGE_QUEUE, await claimDueEngagements(master, now), 'engage');
  } else {
    console.warn('[reach-warmup] dispatch: WARMUP_ENGAGE_QUEUE is not bound; engagements are not dispatched');
  }

  if (expired + sendQueued + engageQueued > 0) {
    console.log(`[reach-warmup] dispatch: send=${sendQueued} engage=${engageQueued} expired=${expired}`);
  }
  return { status: 'ok', expired, sendQueued, engageQueued };
}

/** Cron entry point (index.ts). The tick returns what it did, for tests. */
export async function runDispatch(env: Env, deps: JobDeps = {}): Promise<void> {
  await runDispatchTick(env, deps);
}

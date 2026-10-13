/**
 * Pool mailbox state the worker writes, and how reach-api hears about it.
 *
 * reach-api reads `status`, `pausedReason` and `lastLoginError` from the pool
 * row to show a mailbox's warmup and to keep the tenant mailbox in `error`
 * while a login problem stands. So every time this worker sets or clears one
 * of its own states it also marks the workspace due in the D1 schedule index
 * (kind `reach_warmup`), and reach-api's sweep reacts the same day.
 *
 * The worker only ever sets and clears its own states:
 *   error  + login_failed          a login was rejected
 *   paused + credentials_unavailable   the sealed login cannot be opened
 *   paused + low_inbox_rate        placement dropped (daily)
 * A mailbox paused for any other reason (the customer, staff, a suspended
 * mailbox or domain) is never changed by it.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { unpausedStatus } from '@weldsuite/reach-domain/warmup-pool';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../env';
import { ELIGIBLE_STATUSES, pool, type MasterDatabase, type PoolMailbox } from './db';
import { clip } from './sql';

export const LOGIN_FAILED_REASON = 'login_failed';
export const LOW_INBOX_RATE_REASON = 'low_inbox_rate';
export const CREDENTIALS_UNAVAILABLE_REASON = 'credentials_unavailable';

export type IndexEnv = Pick<Env, 'SCHEDULE_INDEX'>;
export type LoginSource = 'smtp' | 'imap';

/** Tell reach-api's warmup sweep to look at this workspace now. Best-effort. */
export async function markReachDue(env: IndexEnv, clerkOrgId: string, now: Date): Promise<void> {
  await markWorkspaceDue(env.SCHEDULE_INDEX, 'reach_warmup', clerkOrgId, now.getTime());
}

type MailboxRef = Pick<PoolMailbox, 'id' | 'clerkOrgId'>;

/**
 * A login was rejected. An active mailbox goes to `error` (login_failed) and
 * stays out of the network until a login works again; a mailbox that is
 * already parked for another reason keeps its status and only records the error.
 */
export async function recordLoginFailure(
  env: IndexEnv,
  master: MasterDatabase,
  mailbox: MailboxRef,
  source: LoginSource,
  detail: string,
  now: Date,
): Promise<void> {
  const lastLoginError = clip(`${source}: ${detail}`, 300);
  const stopped = await master
    .update(pool)
    .set({ status: 'error', pausedReason: LOGIN_FAILED_REASON, lastLoginError, lastLoginErrorAt: now, updatedAt: now })
    .where(and(eq(pool.id, mailbox.id), inArray(pool.status, ELIGIBLE_STATUSES)))
    .returning({ id: pool.id });
  if (stopped.length === 0) {
    await master
      .update(pool)
      .set({ lastLoginError, lastLoginErrorAt: now, updatedAt: now })
      .where(eq(pool.id, mailbox.id));
  }
  await markReachDue(env, mailbox.clerkOrgId, now);
}

/** The sealed login cannot be opened: park the mailbox until someone registers it again. */
export async function pauseForCredentials(
  env: IndexEnv,
  master: MasterDatabase,
  mailbox: MailboxRef,
  now: Date,
): Promise<void> {
  const paused = await master
    .update(pool)
    .set({
      status: 'paused',
      pausedReason: CREDENTIALS_UNAVAILABLE_REASON,
      lastLoginError: CREDENTIALS_UNAVAILABLE_REASON,
      lastLoginErrorAt: now,
      updatedAt: now,
    })
    .where(and(eq(pool.id, mailbox.id), inArray(pool.status, ELIGIBLE_STATUSES)))
    .returning({ id: pool.id });
  if (paused.length > 0) await markReachDue(env, mailbox.clerkOrgId, now);
}

type LoginState = Pick<
  PoolMailbox,
  'id' | 'clerkOrgId' | 'status' | 'pausedReason' | 'startedAt' | 'rampDay' | 'lastLoginError'
>;

/** `error` + `login_failed`: the state a successful login lifts. */
export function isLoginFailedState(mailbox: Pick<PoolMailbox, 'status' | 'pausedReason'>): boolean {
  return mailbox.status === 'error' && mailbox.pausedReason === LOGIN_FAILED_REASON;
}

/**
 * An SMTP send or an IMAP login worked. Any stored login error is cleared; a
 * mailbox that was in `error` (login_failed) goes back to where its warmup had
 * got to. Costs nothing for a mailbox without an error (the common case).
 */
export async function recordLoginSuccess(
  env: IndexEnv,
  master: MasterDatabase,
  mailbox: LoginState,
  now: Date,
): Promise<void> {
  const restore = isLoginFailedState(mailbox);
  if (!mailbox.lastLoginError && !restore) return;

  await master
    .update(pool)
    .set({ lastLoginError: null, lastLoginErrorAt: null, updatedAt: now })
    .where(eq(pool.id, mailbox.id));
  if (restore) {
    await master
      .update(pool)
      .set({ status: unpausedStatus(mailbox), pausedReason: null, updatedAt: now })
      .where(and(eq(pool.id, mailbox.id), eq(pool.status, 'error'), eq(pool.pausedReason, LOGIN_FAILED_REASON)));
  }
  await markReachDue(env, mailbox.clerkOrgId, now);
}

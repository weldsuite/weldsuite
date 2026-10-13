/**
 * Login recheck (runs with the planner, every 30 minutes): lets a mailbox that
 * this worker took out of the network come back once its login works again.
 *
 * A mailbox in `error` (login_failed) neither sends nor receives, so nothing
 * else ever logs in to it. Here, a few of them per run get one IMAP login:
 *
 *   - after reach-api registered new logins (it clears `last_login_error`), at once;
 *   - after an earlier IMAP failure, again once the error is 6 hours old;
 *   - a failure that came from SMTP is only retried after the logins are
 *     registered again, because an IMAP login cannot tell whether SMTP works.
 *
 * Success restores the mailbox to where its warmup had got to; failure records
 * the error and backs off 6 hours. Only this worker's own login_failed state is
 * ever lifted: a pause with any other reason (the customer, staff, a suspended
 * mailbox or domain, unavailable credentials) is left to whoever set it.
 */

import { and, eq, isNull, like, lt, or } from 'drizzle-orm';
import { connectImap, ImapError, type ImapSession } from '@weldsuite/imap';
import { openWarmupCredentials, unpausedStatus } from '@weldsuite/reach-domain/warmup-pool';
import type { Env } from './env';
import { pool, type MasterDatabase, type PoolMailbox } from './lib/db';
import { CREDENTIALS_UNAVAILABLE_REASON, LOGIN_FAILED_REASON, markReachDue } from './lib/pool-state';
import { HOUR_MS } from './lib/random';
import { clip } from './lib/sql';

/** Mailboxes tried per run. */
export const RECHECK_LIMIT = 10;
/** A failed recheck is not repeated sooner than this. */
export const RECHECK_BACKOFF_MS = 6 * HOUR_MS;

export interface RecheckResult {
  checked: number;
  healed: number;
}

type RecheckEnv = Pick<Env, 'WELDREACH_WARMUP_KEY' | 'SCHEDULE_INDEX'>;

async function loadCandidates(master: MasterDatabase, now: Date): Promise<PoolMailbox[]> {
  const cutoff = new Date(now.getTime() - RECHECK_BACKOFF_MS);
  const loginFailed = and(
    eq(pool.status, 'error'),
    eq(pool.pausedReason, LOGIN_FAILED_REASON),
    or(isNull(pool.lastLoginError), and(like(pool.lastLoginError, 'imap:%'), lt(pool.lastLoginErrorAt, cutoff))),
  );
  return master.select().from(pool).where(loginFailed).limit(RECHECK_LIMIT);
}

/**
 * The mailbox is still not usable: note why and start the back-off. reach-api
 * is only told when the error text appears for the first time (it was cleared
 * by a re-registration), not on every repeat.
 */
async function stillBroken(
  env: RecheckEnv,
  master: MasterDatabase,
  mailbox: PoolMailbox,
  detail: string,
  now: Date,
): Promise<void> {
  await master
    .update(pool)
    .set({ lastLoginError: clip(`imap: ${detail}`, 300), lastLoginErrorAt: now })
    .where(eq(pool.id, mailbox.id));
  if (mailbox.lastLoginError === null) await markReachDue(env, mailbox.clerkOrgId, now);
}

async function bringBack(env: RecheckEnv, master: MasterDatabase, mailbox: PoolMailbox, now: Date): Promise<void> {
  await master
    .update(pool)
    .set({ status: unpausedStatus(mailbox), pausedReason: null, lastLoginError: null, lastLoginErrorAt: null, updatedAt: now })
    .where(and(eq(pool.id, mailbox.id), eq(pool.status, 'error'), eq(pool.pausedReason, LOGIN_FAILED_REASON)));
  await markReachDue(env, mailbox.clerkOrgId, now);
}

/** One login. true = it worked. */
async function tryLogin(
  env: RecheckEnv,
  master: MasterDatabase,
  mailbox: PoolMailbox,
  now: Date,
): Promise<boolean> {
  const imap = await openWarmupCredentials(env, mailbox.imapCredentials);
  if (!imap) {
    await stillBroken(env, master, mailbox, CREDENTIALS_UNAVAILABLE_REASON, now);
    return false;
  }
  let session: ImapSession | null = null;
  try {
    session = await connectImap({ host: imap.host, port: imap.port, username: imap.username, password: imap.password });
    return true;
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    await stillBroken(env, master, mailbox, err.response ?? err.message, now);
    return false;
  } finally {
    await session?.logout();
  }
}

export async function recheckLogins(env: RecheckEnv, master: MasterDatabase, now: Date): Promise<RecheckResult> {
  const candidates = await loadCandidates(master, now);
  let healed = 0;
  for (const mailbox of candidates) {
    try {
      if (!(await tryLogin(env, master, mailbox, now))) continue;
      await bringBack(env, master, mailbox, now);
      healed++;
    } catch (err) {
      console.warn(`[reach-warmup] login recheck ${mailbox.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: candidates.length, healed };
}

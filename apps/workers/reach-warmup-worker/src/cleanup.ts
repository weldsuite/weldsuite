/**
 * Cleanup (daily): warmup mail older than WARMUP_CLEANUP_AFTER_DAYS is deleted
 * from the mailboxes it sits in, so they stay light and the pool does not
 * pile up thousands of generated threads.
 *
 * Each engaged / missing message is removed from the recipient's INBOX and the
 * sender's Sent folder, found by Message-ID over IMAP (moved to Trash and deleted
 * there, so Gmail really drops it instead of archiving it). One IMAP session per
 * mailbox, at most CLEANUP_MAX_MAILBOXES mailboxes per run, so a run stays
 * inside the subrequest and time limits; the rest follows on later days.
 * `cleaned_at` is set only for messages that were cleaned on both sides.
 *
 * The `reach_warmup_messages` rows themselves are kept ROW_RETENTION_DAYS (30)
 * and then deleted; reach-api's inbound filter reads them until then.
 */

import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { connectImap, ImapError, type ImapSession } from '@weldsuite/imap';
import { WARMUP_CLEANUP_AFTER_DAYS } from '@weldsuite/reach-domain/warmup';
import { openWarmupCredentials, type WarmupKeyEnv } from '@weldsuite/reach-domain/warmup-pool';
import { messages, pool, type MasterDatabase, type PoolMailbox } from './lib/db';
import { DAY_MS } from './lib/random';
import { recordLoginFailure, recordLoginSuccess, type IndexEnv } from './lib/pool-state';

export type CleanupEnv = WarmupKeyEnv & IndexEnv;

export const CLEANUP_MAX_MAILBOXES = 30;
/** Message-IDs searched per mailbox per run. */
export const CLEANUP_MAX_IDS_PER_MAILBOX = 60;
export const CLEANUP_CANDIDATE_LIMIT = 500;
export const ROW_RETENTION_DAYS = 30;
/** Mailboxes cleaned at once (a Worker holds at most 6 open connections). */
const CLEANUP_CONCURRENCY = 3;

export interface CleanupCandidate {
  id: string;
  fromMailboxId: string;
  toMailboxId: string;
  messageIdHeader: string;
}

export interface MailboxWork {
  /** Message-IDs to delete from INBOX (as recipient). */
  inbox: string[];
  /** Message-IDs to delete from the Sent folder (as sender). */
  sent: string[];
}

export interface CleanupPlan {
  work: Map<string, MailboxWork>;
  /** The messages this run takes on, whole (both sides). */
  selected: CleanupCandidate[];
}

function workOf(work: Map<string, MailboxWork>, mailboxId: string): MailboxWork {
  let existing = work.get(mailboxId);
  if (!existing) {
    existing = { inbox: [], sent: [] };
    work.set(mailboxId, existing);
  }
  return existing;
}

function idsOf(work: MailboxWork | undefined): number {
  return work ? work.inbox.length + work.sent.length : 0;
}

/**
 * Pick whole messages (oldest first) while the mailboxes they touch stay within
 * `maxMailboxes` and each mailbox within `maxIds` Message-IDs.
 */
export function planCleanup(
  candidates: readonly CleanupCandidate[],
  maxMailboxes = CLEANUP_MAX_MAILBOXES,
  maxIds = CLEANUP_MAX_IDS_PER_MAILBOX,
): CleanupPlan {
  const work = new Map<string, MailboxWork>();
  const selected: CleanupCandidate[] = [];
  for (const candidate of candidates) {
    const touched = new Set([candidate.fromMailboxId, candidate.toMailboxId]);
    const newMailboxes = [...touched].filter((id) => !work.has(id)).length;
    const fits = [...touched].every((id) => idsOf(work.get(id)) < maxIds);
    if (work.size + newMailboxes > maxMailboxes || !fits) continue;
    workOf(work, candidate.toMailboxId).inbox.push(candidate.messageIdHeader);
    workOf(work, candidate.fromMailboxId).sent.push(candidate.messageIdHeader);
    selected.push(candidate);
  }
  return { work, selected };
}

async function findUids(session: ImapSession, messageIds: readonly string[]): Promise<number[]> {
  const uids: number[] = [];
  for (const id of messageIds) uids.push(...(await session.searchByMessageId(id)));
  return uids;
}

/**
 * Delete these messages from `mailbox`. Gmail's IMAP only archives a message
 * deleted from INBOX (it stays in All Mail), so with a Trash folder the mail is
 * moved there first and then deleted from Trash, which does remove it. Without
 * a Trash folder it is deleted in place.
 */
async function deleteByMessageId(
  session: ImapSession,
  mailbox: string,
  messageIds: readonly string[],
  trash: string | null,
): Promise<void> {
  await session.select(mailbox);
  const uids = await findUids(session, messageIds);
  if (uids.length === 0) return;
  if (!trash || trash === mailbox) {
    await session.deleteMessages(uids);
    return;
  }
  await session.move(uids, trash);
  await session.select(trash);
  const trashed = await findUids(session, messageIds);
  if (trashed.length > 0) await session.deleteMessages(trashed);
}

async function cleanOneMailbox(session: ImapSession, work: MailboxWork): Promise<void> {
  const trash = await session.findSpecialUse('\\Trash');
  if (work.inbox.length > 0) await deleteByMessageId(session, 'INBOX', work.inbox, trash);
  if (work.sent.length === 0) return;
  const sentFolder = await session.findSpecialUse('\\Sent');
  if (sentFolder) await deleteByMessageId(session, sentFolder, work.sent, trash);
}

/** Session, work, logout. Resolves true when the mailbox is clean, false when it has to wait for a later run. */
async function cleanMailbox(
  env: CleanupEnv,
  master: MasterDatabase,
  mailbox: PoolMailbox,
  work: MailboxWork,
  now: Date,
): Promise<boolean> {
  const imap = await openWarmupCredentials(env, mailbox.imapCredentials);
  if (!imap) return false;
  let session: ImapSession | null = null;
  try {
    session = await connectImap({ host: imap.host, port: imap.port, username: imap.username, password: imap.password });
    await recordLoginSuccess(env, master, mailbox, now);
    await cleanOneMailbox(session, work);
    return true;
  } catch (err) {
    if (err instanceof ImapError && err.authFailed) {
      await recordLoginFailure(env, master, mailbox, 'imap', err.response ?? err.message, now);
    } else {
      console.warn(`[reach-warmup] cleanup: ${mailbox.id} skipped:`, err instanceof Error ? err.message : err);
    }
    return false;
  } finally {
    await session?.logout();
  }
}

export interface CleanupResult {
  /** Messages cleaned on both sides and marked. */
  cleaned: number;
  mailboxesVisited: number;
  /** Rows older than the retention deleted. */
  rowsDeleted: number;
}

function ageCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Old messages whose mailbox is gone cannot be cleaned: mark them done. */
async function settleRemovedMailboxes(master: MasterDatabase, now: Date): Promise<void> {
  const removed = master.select({ id: pool.id }).from(pool).where(eq(pool.status, 'removed'));
  await master
    .update(messages)
    .set({ cleanedAt: now })
    .where(
      and(
        inArray(messages.status, ['engaged', 'missing']),
        isNull(messages.cleanedAt),
        lt(messages.sentAt, ageCutoff(now, WARMUP_CLEANUP_AFTER_DAYS)),
        or(inArray(messages.fromMailboxId, removed), inArray(messages.toMailboxId, removed)),
      ),
    );
}

async function loadCandidates(master: MasterDatabase, now: Date): Promise<CleanupCandidate[]> {
  // A mailbox in `error` cannot be logged in to until someone fixes it; leaving its
  // messages out keeps them from crowding the run.
  const reachable = master
    .select({ id: pool.id })
    .from(pool)
    .where(inArray(pool.status, ['waiting', 'warming', 'maintaining', 'paused']));
  return master
    .select({
      id: messages.id,
      fromMailboxId: messages.fromMailboxId,
      toMailboxId: messages.toMailboxId,
      messageIdHeader: messages.messageIdHeader,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.status, ['engaged', 'missing']),
        isNull(messages.cleanedAt),
        lt(messages.sentAt, ageCutoff(now, WARMUP_CLEANUP_AFTER_DAYS)),
        inArray(messages.fromMailboxId, reachable),
        inArray(messages.toMailboxId, reachable),
      ),
    )
    .orderBy(asc(messages.sentAt))
    .limit(CLEANUP_CANDIDATE_LIMIT);
}

/** Run `task` over `items`, `limit` at a time. */
async function inGroups<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(task))));
  }
  return results;
}

async function cleanPlanned(
  env: CleanupEnv,
  master: MasterDatabase,
  plan: CleanupPlan,
  now: Date,
): Promise<Set<string>> {
  const mailboxes = await master
    .select()
    .from(pool)
    .where(inArray(pool.id, [...plan.work.keys()]));
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const clean = new Set<string>();
  const ids = [...plan.work.keys()];
  const results = await inGroups(ids, CLEANUP_CONCURRENCY, async (id) => {
    const mailbox = byId.get(id);
    const work = plan.work.get(id);
    return { id, ok: mailbox && work ? await cleanMailbox(env, master, mailbox, work, now) : false };
  });
  for (const result of results) if (result.ok) clean.add(result.id);
  return clean;
}

export async function runCleanup(env: CleanupEnv, master: MasterDatabase, now: Date): Promise<CleanupResult> {
  await settleRemovedMailboxes(master, now);
  const plan = planCleanup(await loadCandidates(master, now));

  let cleaned = 0;
  if (plan.selected.length > 0) {
    const clean = await cleanPlanned(env, master, plan, now);
    const done = plan.selected.filter((m) => clean.has(m.fromMailboxId) && clean.has(m.toMailboxId));
    if (done.length > 0) {
      await master
        .update(messages)
        .set({ cleanedAt: now })
        .where(
          inArray(
            messages.id,
            done.map((m) => m.id),
          ),
        );
    }
    cleaned = done.length;
  }

  const deleted = await master
    .delete(messages)
    .where(lt(messages.createdAt, ageCutoff(now, ROW_RETENTION_DAYS)))
    .returning({ id: messages.id });
  return { cleaned, mailboxesVisited: plan.work.size, rowsDeleted: deleted.length };
}

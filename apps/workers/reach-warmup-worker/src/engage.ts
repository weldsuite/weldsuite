/**
 * Engager (queue `reach-warmup-engage`): acts on one sent warmup email in the
 * recipient's mailbox, over IMAP.
 *
 *   1. find it by Message-ID in INBOX, else in the Junk folder (SPECIAL-USE);
 *      a hit in Junk is moved to INBOX
 *   2. record where it landed (`inbox` / `spam`): the inbox-placement signal
 *   3. open it: `\Seen`, and `\Flagged` on about one in five
 *   4. maybe reply: a new scheduled message in the same thread, sent the other
 *      way with In-Reply-To / References
 *
 * Not found anywhere: try again in 2 hours, and after 3 attempts the message is
 * `missing`. A rejected login pauses the recipient mailbox (`error`,
 * login_failed) and the message is tried again 6 hours later without counting.
 * Other IMAP failures retry sooner and end as `failed`, never as `missing`: only
 * a clean search that finds nothing says the email did not arrive.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { connectImap, ImapError, type ImapSession } from '@weldsuite/imap';
import { WARMUP_REPLY_RATE_MAX, WARMUP_REPLY_RATE_MIN } from '@weldsuite/reach-domain/warmup';
import { openWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';
import { generateMessageId } from '@weldsuite/smtp';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, WarmupEngageMessage } from './env';
import { loadCorpusForLookup, renderCorpusMessage, type CorpusThread } from './corpus';
import { MAX_ENGAGE_ATTEMPTS } from './dispatch';
import { takeClaim } from './lib/claim';
import {
  isEligible,
  messages,
  openMaster,
  personOf,
  pool,
  type JobDeps,
  type MasterDatabase,
  type PoolMailbox,
  type WarmupMessage,
} from './lib/db';
import { isWarmupEnabled } from './lib/flag';
import { pauseForCredentials, recordLoginFailure, recordLoginSuccess } from './lib/pool-state';
import { messageIdsOf, parseMessageId } from './lib/queue';
import { HOUR_MS, MINUTE_MS, chance, randomBetween, randomFloat, type Rng } from './lib/random';
import { clip } from './lib/sql';
import { intoBusinessHours } from './lib/time';

/** Share of received emails that also get `\Flagged`. */
export const FLAG_RATE = 0.2;
/** Chance that a thread continues after its first reply. */
export const CONTINUE_RATE = 0.5;
/** A reply goes out this long after the engagement (then into the replier's business hours). */
export const REPLY_DELAY_MIN_MINUTES = 20;
export const REPLY_DELAY_MAX_MINUTES = 4 * 60;
/** Wait before searching again after a clean miss. */
export const NOT_FOUND_RETRY_MS = 2 * HOUR_MS;
/** Wait after the recipient's login was rejected or its mailbox is parked. */
export const LOGIN_RETRY_MS = 6 * HOUR_MS;
/** Wait after a connection error or timeout. */
export const TRANSIENT_RETRY_MS = 30 * MINUTE_MS;
/** A message whose recipient stays parked longer than this is given up on. */
export const INACTIVE_GIVE_UP_MS = 48 * HOUR_MS;
const RETRY_DELAY_SECONDS = 60;

export type EngageOutcome =
  | { status: 'engaged'; placement: 'inbox' | 'spam'; replyScheduled: boolean }
  | { status: 'missing' }
  | { status: 'deferred'; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

export interface EngageContext {
  env: Env;
  master: MasterDatabase;
  now: Date;
  rng: Rng;
  corpus: () => Promise<CorpusThread[]>;
}

function lazyCorpus(env: Env): () => Promise<CorpusThread[]> {
  let loaded: Promise<CorpusThread[]> | null = null;
  return () => {
    loaded ??= loadCorpusForLookup(env);
    return loaded;
  };
}

/** Free the claim and record the new state. Only touches a row that is still `sent`. */
async function settle(ctx: EngageContext, id: string, patch: Partial<typeof messages.$inferInsert>): Promise<void> {
  await ctx.master
    .update(messages)
    .set({ ...patch, claimedAt: null })
    .where(and(eq(messages.id, id), eq(messages.status, 'sent')));
}

async function deferEngagement(ctx: EngageContext, id: string, afterMs: number, patch = {}): Promise<void> {
  await settle(ctx, id, { ...patch, engageAt: new Date(ctx.now.getTime() + afterMs) });
}

async function giveUp(ctx: EngageContext, id: string, error: string): Promise<EngageOutcome> {
  const text = clip(error);
  await settle(ctx, id, { status: 'failed', error: text });
  return { status: 'failed', error: text };
}

async function loadParties(
  ctx: EngageContext,
  row: WarmupMessage,
): Promise<{ sender: PoolMailbox | undefined; recipient: PoolMailbox | undefined }> {
  const rows = await ctx.master
    .select()
    .from(pool)
    .where(inArray(pool.id, [row.fromMailboxId, row.toMailboxId]));
  return {
    sender: rows.find((mailbox) => mailbox.id === row.fromMailboxId),
    recipient: rows.find((mailbox) => mailbox.id === row.toMailboxId),
  };
}

interface Located {
  placement: 'inbox' | 'spam';
  /** UIDs of the message in INBOX (after a move out of Junk). */
  uids: number[];
  movedFromSpam: boolean;
}

/** INBOX first; then the Junk folder, rescuing the message into INBOX. null = not there. */
async function locateMessage(session: ImapSession, messageId: string): Promise<Located | null> {
  await session.select('INBOX');
  const inInbox = await session.searchByMessageId(messageId);
  if (inInbox.length > 0) return { placement: 'inbox', uids: inInbox, movedFromSpam: false };

  const junk = await session.findSpecialUse('\\Junk');
  if (!junk) return null;
  await session.select(junk);
  const inJunk = await session.searchByMessageId(messageId);
  if (inJunk.length === 0) return null;

  await session.move(inJunk, 'INBOX');
  await session.select('INBOX');
  return { placement: 'spam', uids: await session.searchByMessageId(messageId), movedFromSpam: true };
}

/** `\Seen`, and now and then `\Flagged`. Returns whether it was flagged. */
async function markOpened(session: ImapSession, uids: number[], rng: Rng): Promise<boolean> {
  if (uids.length === 0) return false;
  const flagged = chance(rng, FLAG_RATE);
  await session.addFlags(uids, flagged ? ['\\Seen', '\\Flagged'] : ['\\Seen']);
  return flagged;
}

/** Does this email get a reply? The first reply is decided with the 30-45% rate, later ones continue 50/50. */
function wantsReply(row: WarmupMessage, rng: Rng): boolean {
  if (row.step > 0) return chance(rng, CONTINUE_RATE);
  return chance(rng, randomBetween(rng, WARMUP_REPLY_RATE_MIN, WARMUP_REPLY_RATE_MAX));
}

async function replyExists(ctx: EngageContext, messageIdHeader: string): Promise<boolean> {
  const [existing] = await ctx.master
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.inReplyTo, messageIdHeader))
    .limit(1);
  return existing !== undefined;
}

function referenceChain(row: WarmupMessage): string {
  const earlier = row.references ? row.references.split(' ').filter((id) => id.length > 0) : [];
  return [...earlier, row.messageIdHeader].join(' ');
}

/**
 * Schedule the next step of the thread: from the recipient back to the sender,
 * 20 minutes to 4 hours from now, inside the replier's business hours where
 * possible. A retry of an already handled email finds its reply and adds none.
 */
async function scheduleReply(
  ctx: EngageContext,
  row: WarmupMessage,
  sender: PoolMailbox,
  recipient: PoolMailbox,
): Promise<boolean> {
  const thread = (await ctx.corpus()).find((candidate) => candidate.id === row.corpusThreadId);
  if (!thread || row.step >= thread.messages.length - 1) return false;
  if (!isEligible(sender.status) || !wantsReply(row, ctx.rng)) return false;
  if (await replyExists(ctx, row.messageIdHeader)) return true;

  const next = row.step + 1;
  let subject: string;
  try {
    subject = renderCorpusMessage(thread, next, personOf(recipient), personOf(sender)).subject;
  } catch (err) {
    console.warn(`[reach-warmup] engage ${row.id}: no reply, ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const delay = randomBetween(ctx.rng, REPLY_DELAY_MIN_MINUTES, REPLY_DELAY_MAX_MINUTES) * MINUTE_MS;
  await ctx.master.insert(messages).values({
    id: generateId('rwms'),
    threadId: row.threadId,
    step: next,
    fromMailboxId: recipient.id,
    toMailboxId: sender.id,
    corpusThreadId: row.corpusThreadId,
    messageIdHeader: generateMessageId(recipient.domain),
    inReplyTo: row.messageIdHeader,
    references: referenceChain(row),
    subject,
    status: 'scheduled',
    scheduledAt: intoBusinessHours(new Date(ctx.now.getTime() + delay), recipient.timezone, ctx.rng),
  });
  return true;
}

async function recordEngaged(
  ctx: EngageContext,
  row: WarmupMessage,
  found: Located,
  flagged: boolean,
  replyScheduled: boolean,
): Promise<void> {
  await settle(ctx, row.id, {
    status: 'engaged',
    engagedAt: ctx.now,
    placement: found.placement,
    actions: {
      seen: found.uids.length > 0,
      ...(flagged ? { flagged: true } : {}),
      ...(found.movedFromSpam ? { movedFromSpam: true } : {}),
      ...(replyScheduled ? { replyScheduled: true } : {}),
    },
  });
}

/** A clean search found nothing: again in 2 hours, and `missing` after the third miss. */
async function recordNotFound(ctx: EngageContext, row: WarmupMessage): Promise<EngageOutcome> {
  const attempts = row.engageAttempts + 1;
  if (attempts >= MAX_ENGAGE_ATTEMPTS) {
    await settle(ctx, row.id, { status: 'missing', placement: 'missing', engageAttempts: attempts });
    return { status: 'missing' };
  }
  await deferEngagement(ctx, row.id, NOT_FOUND_RETRY_MS, { engageAttempts: attempts });
  return { status: 'deferred', reason: 'not_found' };
}

/** The connection or a command failed (not the login): count the attempt, try again soon, never conclude `missing`. */
async function recordTransientFailure(ctx: EngageContext, row: WarmupMessage, error: ImapError): Promise<EngageOutcome> {
  const attempts = row.engageAttempts + 1;
  if (attempts >= MAX_ENGAGE_ATTEMPTS) return giveUp(ctx, row.id, `imap_${error.kind}: ${error.message}`);
  await deferEngagement(ctx, row.id, TRANSIENT_RETRY_MS, { engageAttempts: attempts });
  return { status: 'deferred', reason: `imap_${error.kind}` };
}

async function engageViaImap(
  ctx: EngageContext,
  row: WarmupMessage,
  sender: PoolMailbox | undefined,
  recipient: PoolMailbox,
  session: ImapSession,
): Promise<EngageOutcome> {
  const found = await locateMessage(session, row.messageIdHeader);
  if (!found) return recordNotFound(ctx, row);
  const flagged = await markOpened(session, found.uids, ctx.rng);
  const replyScheduled = sender ? await scheduleReply(ctx, row, sender, recipient) : false;
  await recordEngaged(ctx, row, found, flagged, replyScheduled);
  return { status: 'engaged', placement: found.placement, replyScheduled };
}

/** Whether to attempt now. A parked recipient defers the message; one that stays parked too long ends it. */
async function checkRecipient(
  ctx: EngageContext,
  row: WarmupMessage,
  recipient: PoolMailbox | undefined,
): Promise<EngageOutcome | null> {
  if (!recipient || recipient.status === 'removed') return giveUp(ctx, row.id, 'mailbox_inactive');
  if (isEligible(recipient.status)) return null;
  const sentAt = row.sentAt?.getTime() ?? row.createdAt.getTime();
  if (ctx.now.getTime() - sentAt > INACTIVE_GIVE_UP_MS) return giveUp(ctx, row.id, 'mailbox_inactive');
  await deferEngagement(ctx, row.id, LOGIN_RETRY_MS);
  return { status: 'deferred', reason: 'mailbox_inactive' };
}

export async function processEngage(env: Env, messageId: string, ctx: EngageContext): Promise<EngageOutcome> {
  const [row] = await ctx.master.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row || row.status !== 'sent') return { status: 'skipped', reason: 'not_sent' };
  if (!(await takeClaim(ctx.master, row, 'sent', ctx.now))) return { status: 'skipped', reason: 'claim_lost' };

  const { sender, recipient } = await loadParties(ctx, row);
  const blocked = await checkRecipient(ctx, row, recipient);
  if (blocked || !recipient) return blocked ?? { status: 'skipped', reason: 'no_recipient' };

  const imap = await openWarmupCredentials(env, recipient.imapCredentials);
  if (!imap) {
    await pauseForCredentials(ctx.env, ctx.master, recipient, ctx.now);
    await deferEngagement(ctx, row.id, LOGIN_RETRY_MS);
    return { status: 'deferred', reason: 'credentials_unavailable' };
  }

  let session: ImapSession | null = null;
  try {
    session = await connectImap({ host: imap.host, port: imap.port, username: imap.username, password: imap.password });
    await recordLoginSuccess(ctx.env, ctx.master, recipient, ctx.now);
    return await engageViaImap(ctx, row, sender, recipient, session);
  } catch (err) {
    if (!(err instanceof ImapError)) throw err;
    if (err.authFailed) {
      await recordLoginFailure(ctx.env, ctx.master, recipient, 'imap', err.response ?? err.message, ctx.now);
      await deferEngagement(ctx, row.id, LOGIN_RETRY_MS);
      return { status: 'deferred', reason: 'login_failed' };
    }
    return recordTransientFailure(ctx, row, err);
  } finally {
    await session?.logout();
  }
}

export async function handleEngageBatch(
  batch: MessageBatch<WarmupEngageMessage>,
  env: Env,
  _ctx: ExecutionContext,
  deps: JobDeps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const master = openMaster(env, deps);

  if (!(await isWarmupEnabled(env, now))) {
    const ids = messageIdsOf(batch.messages.map((message) => message.body));
    if (ids.length > 0) await master.update(messages).set({ claimedAt: null }).where(inArray(messages.id, ids));
    batch.ackAll();
    return;
  }

  const ctx: EngageContext = { env, master, now, rng: deps.random ?? randomFloat, corpus: lazyCorpus(env) };
  for (const message of batch.messages) {
    const id = parseMessageId(message.body);
    if (id === null) {
      console.warn('[reach-warmup] engage: dropped a queue message without a messageId');
      message.ack();
      continue;
    }
    try {
      const outcome = await processEngage(env, id, ctx);
      if (outcome.status === 'failed') console.warn(`[reach-warmup] engage ${id}: ${outcome.error}`);
      message.ack();
    } catch (err) {
      console.error(`[reach-warmup] engage ${id} failed, will retry:`, err);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

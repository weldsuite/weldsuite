/**
 * Planner (cron, every 30 minutes): turns the pool into scheduled warmup mail.
 *
 *   1. The pool has to span WARMUP_MIN_POOL_DOMAINS domains; below that every
 *      `waiting` mailbox stays waiting and nothing is planned.
 *   2. `waiting` mailboxes start: status `warming`, ramp day 1.
 *   3. Each warming / maintaining mailbox not yet planned for its LOCAL date
 *      gets today's messages: the ramp (or maintenance) target spread over the
 *      rest of its business hours, each with a recipient chosen under the
 *      pairing rules (pairing.ts) and a corpus thread.
 *
 * Master DB only (plus an IMAP login to bring errored mailboxes back, login-recheck.ts). Idempotent per local day: the day is claimed with a single
 * conditional UPDATE (`planned_for` differs from today's date), so two
 * overlapping runs cannot plan one mailbox twice.
 */

import { and, count, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  WARMUP_MAINTAIN_MAX,
  WARMUP_MAINTAIN_MIN,
  WARMUP_MIN_POOL_DOMAINS,
  warmupRampTarget,
} from '@weldsuite/reach-domain/warmup';
import { generateMessageId } from '@weldsuite/smtp';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env } from './env';
import { loadCorpus, renderCorpusMessage, type CorpusThread } from './corpus';
import { messages, openMaster, personOf, pool, type JobDeps, type MasterDatabase } from './lib/db';
import { isWarmupEnabled } from './lib/flag';
import { recheckLogins } from './login-recheck';
import { DAY_MS, HOUR_MS, randomFloat, shuffled, type Rng } from './lib/random';
import { businessWindow, localDate } from './lib/time';
import {
  createPairingState,
  pairKey,
  pickRecipient,
  pickThreadId,
  type PairingMailbox,
  type PairingState,
} from './pairing';
import { dailyTargetFor, newThreadsFor, planDay, spreadTimes } from './schedule';

/** A pair does not start a new thread within this long of its last one (preference, relaxed in a small pool). */
export const PAIR_COOLDOWN_DAYS = 3;
/** Corpus threads the pair used within this long ago are avoided. */
export const THREAD_MEMORY_DAYS = 14;
/** Warmup mail planned this far back (and any later) counts as "received today" for balancing. */
export const BALANCE_WINDOW_MS = 12 * HOUR_MS;
/** Mailboxes planned per run, so one run stays well inside the subrequest limit; the rest wait for the next. */
export const MAX_MAILBOXES_PER_RUN = 150;

type PlanMailbox = Pick<
  typeof pool.$inferSelect,
  | 'id'
  | 'workspaceId'
  | 'email'
  | 'domain'
  | 'mailboxType'
  | 'firstName'
  | 'lastName'
  | 'timezone'
  | 'status'
  | 'rampDay'
  | 'dailyTarget'
  | 'plannedFor'
>;

export interface PlannerResult {
  status: 'disabled' | 'pool_too_small' | 'ok';
  poolMailboxes: number;
  poolDomains: number;
  started: number;
  /** Mailboxes in error / paused for a login problem whose login works again. */
  loginsRestored: number;
  mailboxesPlanned: number;
  messagesPlanned: number;
}

const EMPTY_RESULT: PlannerResult = {
  status: 'ok',
  poolMailboxes: 0,
  poolDomains: 0,
  started: 0,
  loginsRestored: 0,
  mailboxesPlanned: 0,
  messagesPlanned: 0,
};

async function loadEligible(master: MasterDatabase): Promise<PlanMailbox[]> {
  return master
    .select({
      id: pool.id,
      workspaceId: pool.workspaceId,
      email: pool.email,
      domain: pool.domain,
      mailboxType: pool.mailboxType,
      firstName: pool.firstName,
      lastName: pool.lastName,
      timezone: pool.timezone,
      status: pool.status,
      rampDay: pool.rampDay,
      dailyTarget: pool.dailyTarget,
      plannedFor: pool.plannedFor,
    })
    .from(pool)
    .where(inArray(pool.status, ['waiting', 'warming', 'maintaining']));
}

/** waiting -> warming, ramp day 1. Returns how many started; the rows in `mailboxes` are updated to match. */
async function startWaiting(master: MasterDatabase, mailboxes: PlanMailbox[], now: Date): Promise<number> {
  const started = await master
    .update(pool)
    .set({ status: 'warming', startedAt: now, rampDay: 1, rampUpdatedAt: now, updatedAt: now })
    .where(eq(pool.status, 'waiting'))
    .returning({ id: pool.id });
  const ids = new Set(started.map((row) => row.id));
  for (const mailbox of mailboxes) {
    if (ids.has(mailbox.id)) {
      mailbox.status = 'warming';
      mailbox.rampDay = 1;
    }
  }
  return ids.size;
}

/** What a mailbox sends on an ordinary day: the reference for balancing how much it should receive. */
function expectedDailyVolume(mailbox: PlanMailbox): number {
  if (mailbox.status === 'maintaining') return newThreadsFor(Math.round((WARMUP_MAINTAIN_MIN + WARMUP_MAINTAIN_MAX) / 2));
  return newThreadsFor(Math.max(1, warmupRampTarget(mailbox.rampDay)));
}

async function loadReceivedCounts(master: MasterDatabase, now: Date): Promise<Map<string, number>> {
  const rows = await master
    .select({ id: messages.toMailboxId, n: count() })
    .from(messages)
    .where(and(ne(messages.status, 'failed'), gte(messages.scheduledAt, new Date(now.getTime() - BALANCE_WINDOW_MS))))
    .groupBy(messages.toMailboxId);
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

interface PairHistory {
  /** Pairs (either direction) that started a thread within the cool-down. */
  cooling: Set<string>;
  /** Corpus threads each pair used recently. */
  threadsByPair: Map<string, Set<string>>;
}

async function loadPairHistory(master: MasterDatabase, senderId: string, now: Date): Promise<PairHistory> {
  const rows = await master
    .select({
      from: messages.fromMailboxId,
      to: messages.toMailboxId,
      corpusThreadId: messages.corpusThreadId,
      scheduledAt: messages.scheduledAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.step, 0),
        ne(messages.status, 'failed'),
        gte(messages.scheduledAt, new Date(now.getTime() - THREAD_MEMORY_DAYS * DAY_MS)),
        or(eq(messages.fromMailboxId, senderId), eq(messages.toMailboxId, senderId)),
      ),
    );
  const coolingSince = now.getTime() - PAIR_COOLDOWN_DAYS * DAY_MS;
  const history: PairHistory = { cooling: new Set(), threadsByPair: new Map() };
  for (const row of rows) {
    const key = pairKey(row.from, row.to);
    if (row.scheduledAt.getTime() >= coolingSince) history.cooling.add(key);
    const used = history.threadsByPair.get(key) ?? new Set<string>();
    used.add(row.corpusThreadId);
    history.threadsByPair.set(key, used);
  }
  return history;
}

interface PlanContext {
  master: MasterDatabase;
  now: Date;
  rng: Rng;
  threads: Map<string, CorpusThread>;
  threadIds: string[];
  /** Everyone who can receive. */
  candidates: PairingMailbox[];
  mailboxes: Map<string, PlanMailbox>;
  /** Planned receives per mailbox, shared across senders (mutated as messages are planned). */
  received: Map<string, number>;
  threadUse: Map<string, number>;
}

function toPairing(mailbox: PlanMailbox): PairingMailbox {
  return {
    id: mailbox.id,
    workspaceId: mailbox.workspaceId,
    domain: mailbox.domain,
    mailboxType: mailbox.mailboxType,
    capacity: expectedDailyVolume(mailbox),
  };
}

/**
 * Take today for this mailbox. false when another run already planned its
 * local date (or the mailbox stopped being active in the meantime).
 */
async function claimDay(ctx: PlanContext, mailbox: PlanMailbox, date: string, planned: number): Promise<boolean> {
  const claimed = await ctx.master
    .update(pool)
    .set({ plannedFor: date, dailyTarget: planned, updatedAt: ctx.now })
    .where(
      and(
        eq(pool.id, mailbox.id),
        inArray(pool.status, ['warming', 'maintaining']),
        or(isNull(pool.plannedFor), ne(pool.plannedFor, date)),
      ),
    )
    .returning({ id: pool.id });
  return claimed.length > 0;
}

/** Hand the day back after a failed insert, so the next run plans it again. */
async function releaseDay(ctx: PlanContext, mailbox: PlanMailbox): Promise<void> {
  await ctx.master
    .update(pool)
    .set({ plannedFor: mailbox.plannedFor, dailyTarget: mailbox.dailyTarget })
    .where(eq(pool.id, mailbox.id));
}

type NewMessage = typeof messages.$inferInsert;

function buildMessage(
  ctx: PlanContext,
  sender: PlanMailbox,
  recipient: PlanMailbox,
  threadId: string,
  at: Date,
): NewMessage | null {
  const thread = ctx.threads.get(threadId);
  if (!thread) return null;
  const rendered = renderCorpusMessage(thread, 0, personOf(sender), personOf(recipient));
  return {
    id: generateId('rwms'),
    threadId: generateId('rwth'),
    step: 0,
    fromMailboxId: sender.id,
    toMailboxId: recipient.id,
    corpusThreadId: thread.id,
    // Stored before the send: reach-api drops forwarded warmup mail by this id.
    messageIdHeader: generateMessageId(sender.domain),
    inReplyTo: null,
    references: null,
    subject: rendered.subject,
    status: 'scheduled',
    scheduledAt: at,
  };
}

function chooseThread(ctx: PlanContext, history: PairHistory, senderId: string, recipientId: string): string | null {
  const key = pairKey(senderId, recipientId);
  const used = history.threadsByPair.get(key) ?? new Set<string>();
  const chosen = pickThreadId(ctx.threadIds, used, ctx.threadUse, ctx.rng);
  if (chosen) {
    used.add(chosen);
    history.threadsByPair.set(key, used);
  }
  return chosen;
}

function buildDayMessages(
  ctx: PlanContext,
  sender: PlanMailbox,
  history: PairHistory,
  times: Date[],
): NewMessage[] {
  const state: PairingState = createPairingState(ctx.received, history.cooling);
  const senderNode = toPairing(sender);
  const rows: NewMessage[] = [];
  for (const at of times) {
    const recipientNode = pickRecipient(senderNode, ctx.candidates, state, ctx.rng);
    const recipient = recipientNode ? ctx.mailboxes.get(recipientNode.id) : undefined;
    if (!recipient) break;
    const threadId = chooseThread(ctx, history, sender.id, recipient.id);
    const row = threadId ? buildMessage(ctx, sender, recipient, threadId, at) : null;
    if (row) rows.push(row);
  }
  return rows;
}

/** Plan one mailbox's local day. Returns the messages planned, or null when the day was not ours to plan. */
async function planMailbox(ctx: PlanContext, sender: PlanMailbox): Promise<number | null> {
  const window = businessWindow(ctx.now, sender.timezone);
  const status = sender.status === 'maintaining' ? 'maintaining' : 'warming';
  const target = dailyTargetFor(status, Math.max(1, sender.rampDay), ctx.rng);
  const day = planDay(target, window, ctx.now);

  if (!(await claimDay(ctx, sender, window.date, day.count))) return null;
  if (day.count === 0) return 0;

  try {
    const history = await loadPairHistory(ctx.master, sender.id, ctx.now);
    const times = spreadTimes(day.from, day.until, day.count, ctx.rng);
    const rows = buildDayMessages(ctx, sender, history, times);
    if (rows.length > 0) await ctx.master.insert(messages).values(rows);
    if (rows.length !== day.count) {
      await ctx.master.update(pool).set({ dailyTarget: rows.length }).where(eq(pool.id, sender.id));
    }
    return rows.length;
  } catch (err) {
    await releaseDay(ctx, sender).catch(() => undefined);
    throw err;
  }
}

async function planAll(ctx: PlanContext, due: PlanMailbox[]): Promise<{ mailboxes: number; messages: number }> {
  let mailboxes = 0;
  let planned = 0;
  for (const sender of due) {
    try {
      const n = await planMailbox(ctx, sender);
      if (n === null) continue;
      mailboxes++;
      planned += n;
    } catch (err) {
      console.error(`[reach-warmup] planner: ${sender.id} failed:`, err);
    }
  }
  return { mailboxes, messages: planned };
}

/** Mailboxes this worker parked for a login problem come back once a login works again. */
async function restoreLogins(env: Env, master: MasterDatabase, now: Date): Promise<number> {
  try {
    return (await recheckLogins(env, master, now)).healed;
  } catch (err) {
    console.error('[reach-warmup] planner: login recheck failed:', err);
    return 0;
  }
}

export async function runPlannerTick(env: Env, deps: JobDeps = {}): Promise<PlannerResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!(await isWarmupEnabled(env, now))) return { ...EMPTY_RESULT, status: 'disabled' };

  const master = openMaster(env, deps);
  const rng = deps.random ?? randomFloat;
  const loginsRestored = await restoreLogins(env, master, now);
  const eligible = await loadEligible(master);
  const poolDomains = new Set(eligible.map((mailbox) => mailbox.domain)).size;
  const base = { poolMailboxes: eligible.length, poolDomains, loginsRestored };

  if (poolDomains < WARMUP_MIN_POOL_DOMAINS) {
    console.log(
      `[reach-warmup] planner: pool spans ${poolDomains} domain(s), needs ${WARMUP_MIN_POOL_DOMAINS}; waiting (${eligible.length} mailboxes)`,
    );
    return { ...EMPTY_RESULT, ...base, status: 'pool_too_small' };
  }

  const started = await startWaiting(master, eligible, now);
  const due = shuffled(
    rng,
    eligible.filter(
      (mailbox) =>
        (mailbox.status === 'warming' || mailbox.status === 'maintaining') &&
        mailbox.plannedFor !== localDate(now, mailbox.timezone),
    ),
  ).slice(0, MAX_MAILBOXES_PER_RUN);

  if (due.length === 0) {
    if (started > 0) console.log(`[reach-warmup] planner: started=${started}, nothing due`);
    return { ...EMPTY_RESULT, ...base, started };
  }

  const corpus = await loadCorpus(env);
  const ctx: PlanContext = {
    master,
    now,
    rng,
    threads: new Map(corpus.map((thread) => [thread.id, thread])),
    threadIds: corpus.map((thread) => thread.id),
    candidates: eligible.map(toPairing),
    mailboxes: new Map(eligible.map((mailbox) => [mailbox.id, mailbox])),
    received: await loadReceivedCounts(master, now),
    threadUse: new Map(),
  };

  const planned = await planAll(ctx, due);
  console.log(
    `[reach-warmup] planner: pool=${eligible.length}/${poolDomains}d started=${started} planned=${planned.mailboxes} messages=${planned.messages}`,
  );
  return { ...EMPTY_RESULT, status: 'ok', ...base, started, mailboxesPlanned: planned.mailboxes, messagesPlanned: planned.messages };
}

/** Cron entry point (index.ts). The tick returns what it did, for tests. */
export async function runPlanner(env: Env, deps: JobDeps = {}): Promise<void> {
  await runPlannerTick(env, deps);
}

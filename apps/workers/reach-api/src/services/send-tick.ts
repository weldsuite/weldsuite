/**
 * One send tick for one workspace: the I/O half of the send engine
 * (`services/scheduler.ts` holds the rules).
 *
 *   1. mark crashed sends `unknown` (never retried);
 *   2. load the active campaigns, their mailboxes, steps and today's counts;
 *   3. push enrollments that cannot send right now (window closed, daily limit,
 *      mailbox capped or unusable) to the moment they can, so they do not pile
 *      up as "due" and keep waking the workspace;
 *   4. claim due enrollments atomically (`claimed_at`) and look at each before
 *      planning (deleted prospect, suppression, consumer domain, missing
 *      variables, a step that already went out);
 *   5. plan and send, one email per mailbox, a few connections at a time;
 *   6. advance / stop each enrollment, update counters, apply the guardrails,
 *      complete finished campaigns;
 *   7. report when the workspace next has work.
 *
 * A message row that already exists for the step (a crash between the SMTP
 * reply and the enrollment update) advances the enrollment instead of sending
 * again.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, min, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { publishEntityEventRaw, type EntityAction } from '@weldsuite/entity-events';
import type { Database } from '@weldsuite/worker-kit';
import type { SmtpSocketFactory } from '@weldsuite/smtp';
import { isConsumerEmail, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  type ReachCampaign,
  type ReachCampaignStep,
  type ReachEnrollment,
  type ReachMailbox,
  type ReachMessage,
  type ReachProspect,
} from '@weldsuite/db/schema';
import { completeFinishedCampaigns } from '@weldsuite/reach-domain/campaign-completion';
import { addToCampaignStats, loadReachSettings, scheduleOf } from '@weldsuite/reach-domain/campaigns';
import { CREDENTIALS_UNAVAILABLE, sendFromMailbox } from '@weldsuite/reach-domain/outbound';
import { countSentToday, DEFAULT_DAY_TIMEZONE } from '@weldsuite/reach-domain/overview';
import { buildTemplateValues, composeBody, renderStepContent, replySubject } from '@weldsuite/reach-domain/render';
import { startOfZonedDay } from '@weldsuite/reach-domain/send-window';
import { loadSuppressionIndex, suppressEmail, type SuppressionIndex } from '@weldsuite/reach-domain/suppressions';
import type { Env } from '../types';
import { recordHardBounce, type GuardrailHooks } from './guardrails';
import {
  CLAIM_STALE_MS,
  MIN_RETRY_MS,
  STUCK_SENDING_MS,
  TEMPORARY_RETRY_MS,
  UNAVAILABLE_RETRY_MS,
  assessMailboxes,
  evaluateCampaignGate,
  nextDayWindowStart,
  nextStepDueAt,
  planSends,
  type PlanCampaign,
  type PlanContext,
  type PlanEnrollment,
  type PlanMailbox,
  type PlannedSend,
  type Readiness,
} from './scheduler';

/** Most rows one tick claims. */
const CLAIM_MAX = 100;
/** SMTP connections open at once (Workers allow six simultaneous connections). */
const SEND_CONCURRENCY = 4;
/** A step that failed this many times stops the enrollment. */
export const MAX_SEND_ATTEMPTS = 5;
const IN_FLIGHT_RETRY_MS = 5 * 60_000;
/** The earliest a still-due workspace is looked at again. */
const RETRY_FLOOR_MS = 15_000;

export interface TickDeps {
  env: Env;
  db: Database;
  /** Clerk org id: the workspace id on entity events. */
  clerkOrgId: string;
  limits: WeldReachLimits;
  /** Injected in tests; defaults to cloudflare:sockets. */
  connect?: SmtpSocketFactory;
  now?: () => Date;
}

export interface TickResult {
  claimed: number;
  sent: number;
  bounced: number;
  failed: number;
  /** Enrollments put back for later (limits, gaps, mailbox problems). */
  deferred: number;
  /** When the workspace next has work; null when nothing is left to send. */
  nextDueAt: Date | null;
}

type EnrollmentPatch = Partial<typeof reachEnrollments.$inferInsert>;

type MailboxRow = Pick<
  ReachMailbox,
  'id' | 'email' | 'firstName' | 'lastName' | 'signature' | 'status' | 'dailyCap' | 'rampCurrent' | 'lastSentAt'
>;

type Outcome =
  | { kind: 'sent'; message: ReachMessage }
  | { kind: 'uncertain'; message: ReachMessage }
  | { kind: 'bounced'; message: ReachMessage }
  | { kind: 'auth_failed'; error: string }
  | { kind: 'mailbox_unusable'; error: string; credentialsMissing: boolean }
  | { kind: 'rejected' }
  | { kind: 'temporary' }
  | { kind: 'busy' }
  | { kind: 'missing_variables' };

/** Everything loaded once per tick. */
interface TickState {
  deps: TickDeps;
  now: Date;
  campaigns: Map<string, ReachCampaign>;
  planCampaigns: Map<string, PlanCampaign>;
  planMailboxes: Map<string, PlanMailbox>;
  mailboxes: Map<string, MailboxRow>;
  steps: Map<string, ReachCampaignStep[]>;
  ctx: PlanContext;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** An outbound row still `sending` long after its tick belongs to a crashed send. */
export async function markStuckSendingMessages(db: Database, now: Date): Promise<number> {
  const rows = await db
    .update(reachMessages)
    .set({ status: 'unknown', error: 'Send interrupted; delivery unknown', updatedAt: now })
    .where(
      and(
        eq(reachMessages.direction, 'out'),
        eq(reachMessages.status, 'sending'),
        lt(reachMessages.createdAt, new Date(now.getTime() - STUCK_SENDING_MS)),
      ),
    )
    .returning({ id: reachMessages.id });
  return rows.length;
}

async function publishRaw(
  deps: Pick<TickDeps, 'env' | 'clerkOrgId'>,
  entityType: 'reach_campaign' | 'reach_mailbox',
  action: EntityAction,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await publishEntityEventRaw({
    env: deps.env,
    workspaceId: deps.clerkOrgId,
    userId: 'system',
    entityType,
    action,
    entityId,
    data,
  });
}

function guardrailHooks(deps: TickDeps): GuardrailHooks {
  return {
    onMailboxPaused: (m) =>
      publishRaw(deps, 'reach_mailbox', 'updated', m.id, { id: m.id, email: m.email, status: m.status, pausedReason: m.pausedReason }),
    onCampaignPaused: (c) => publishRaw(deps, 'reach_campaign', 'paused', c.id, { ...c }),
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadTickState(deps: TickDeps, now: Date, campaignRows: ReachCampaign[]): Promise<TickState> {
  const { db } = deps;
  const campaignIds = campaignRows.map((c) => c.id);
  const settings = await loadReachSettings(db);
  const dayTimezone = settings?.defaultTimezone ?? DEFAULT_DAY_TIMEZONE;

  const [links, mailboxRows, stepRows, sentToday] = await Promise.all([
    db.select().from(reachCampaignMailboxes).where(inArray(reachCampaignMailboxes.campaignId, campaignIds)),
    db
      .select({
        id: reachMailboxes.id,
        email: reachMailboxes.email,
        firstName: reachMailboxes.firstName,
        lastName: reachMailboxes.lastName,
        signature: reachMailboxes.signature,
        status: reachMailboxes.status,
        dailyCap: reachMailboxes.dailyCap,
        rampCurrent: reachMailboxes.rampCurrent,
        lastSentAt: reachMailboxes.lastSentAt,
      })
      .from(reachMailboxes)
      .where(and(isNull(reachMailboxes.deletedAt), ne(reachMailboxes.status, 'deleted'))),
    db
      .select()
      .from(reachCampaignSteps)
      .where(inArray(reachCampaignSteps.campaignId, campaignIds))
      .orderBy(asc(reachCampaignSteps.order)),
    countSentToday(db, startOfZonedDay(now, dayTimezone)),
  ]);

  const steps = new Map<string, ReachCampaignStep[]>();
  for (const s of stepRows) steps.set(s.campaignId, [...(steps.get(s.campaignId) ?? []), s]);

  return {
    deps,
    now,
    campaigns: new Map(campaignRows.map((c) => [c.id, c])),
    mailboxes: new Map(mailboxRows.map((m) => [m.id, m])),
    steps,
    planMailboxes: new Map(
      mailboxRows.map((m) => [
        m.id,
        {
          id: m.id,
          status: m.status,
          dailyCap: m.dailyCap,
          rampCurrent: m.rampCurrent,
          lastSentAt: m.lastSentAt,
          sentToday: sentToday.byMailbox.get(m.id) ?? 0,
        },
      ]),
    ),
    planCampaigns: new Map(
      campaignRows.map((c) => [
        c.id,
        {
          id: c.id,
          schedule: scheduleOf(c),
          dailyLimit: c.dailyLimit,
          minGapMinutes: c.minGapMinutes,
          sentToday: sentToday.byCampaign.get(c.id) ?? 0,
          mailboxIds: links.filter((l) => l.campaignId === c.id).map((l) => l.mailboxId),
        },
      ]),
    ),
    ctx: {
      now,
      dayTimezone,
      maxDailySends: deps.limits.maxDailySends,
      workspaceSentToday: sentToday.total,
    },
  };
}

// ---------------------------------------------------------------------------
// Defer what cannot send, claim the rest
// ---------------------------------------------------------------------------

function claimable(now: Date): SQL | undefined {
  return or(isNull(reachEnrollments.claimedAt), lt(reachEnrollments.claimedAt, new Date(now.getTime() - CLAIM_STALE_MS)));
}

/** Push due enrollments that cannot send into the future; returns the campaigns that are open now. */
async function deferUnsendable(state: TickState): Promise<{ open: PlanCampaign[]; readiness: Readiness }> {
  const { deps, now, ctx } = state;
  const { db } = deps;
  const dueNow = and(eq(reachEnrollments.status, 'active'), lte(reachEnrollments.nextSendAt, now), claimable(now));

  const open: PlanCampaign[] = [];
  for (const pc of state.planCampaigns.values()) {
    const gate = evaluateCampaignGate(pc, ctx);
    if (gate.open) {
      open.push(pc);
    } else {
      await db
        .update(reachEnrollments)
        .set({ nextSendAt: gate.reopensAt, updatedAt: now })
        .where(and(eq(reachEnrollments.campaignId, pc.id), dueNow));
    }
  }

  const readiness = assessMailboxes(state.planMailboxes.values(), open, now);
  if (open.length === 0) return { open, readiness };

  const openIds = open.map((c) => c.id);
  const activeMailboxIds = [...state.planMailboxes.values()].filter((m) => m.status === 'active').map((m) => m.id);
  // Pinned to a mailbox that cannot send at all: look again in an hour.
  await db
    .update(reachEnrollments)
    .set({ nextSendAt: after(now, UNAVAILABLE_RETRY_MS), updatedAt: now })
    .where(
      and(
        inArray(reachEnrollments.campaignId, openIds),
        dueNow,
        isNotNull(reachEnrollments.mailboxId),
        activeMailboxIds.length > 0 ? notInArray(reachEnrollments.mailboxId, activeMailboxIds) : undefined,
      ),
    );
  for (const pc of open) {
    // Pinned to a mailbox that is out of sends for today: tomorrow's window.
    if (readiness.cappedMailboxIds.size > 0) {
      await db
        .update(reachEnrollments)
        .set({ nextSendAt: nextDayWindowStart(pc, ctx), updatedAt: now })
        .where(
          and(
            eq(reachEnrollments.campaignId, pc.id),
            dueNow,
            inArray(reachEnrollments.mailboxId, [...readiness.cappedMailboxIds]),
          ),
        );
    }
    // First emails of a campaign none of whose mailboxes can send: later, not every minute.
    const until = firstEmailHold(pc, state, readiness);
    if (until) {
      await db
        .update(reachEnrollments)
        .set({ nextSendAt: until, updatedAt: now })
        .where(and(eq(reachEnrollments.campaignId, pc.id), dueNow, isNull(reachEnrollments.mailboxId)));
    }
  }
  return { open, readiness };
}

/**
 * When the first emails of an open campaign can next go, if its mailboxes
 * cannot send them at all today (none active: an hour; all out of sends:
 * tomorrow's window). null when at least one mailbox is available, even if it
 * is only waiting out its gap.
 */
function firstEmailHold(pc: PlanCampaign, state: TickState, readiness: Readiness): Date | null {
  const active = pc.mailboxIds.map((id) => state.planMailboxes.get(id)).filter((m): m is PlanMailbox => m?.status === 'active');
  if (active.length === 0) return after(state.now, UNAVAILABLE_RETRY_MS);
  if (active.every((m) => readiness.cappedMailboxIds.has(m.id))) return nextDayWindowStart(pc, state.ctx);
  return null;
}

/**
 * Claim due enrollments of open campaigns whose mailbox could send now. The
 * outer conditions are re-checked on the row at update time, so two ticks
 * racing for the same rows cannot both claim them.
 */
async function claimDue(state: TickState, open: PlanCampaign[], readiness: Readiness): Promise<ReachEnrollment[]> {
  const { db } = state.deps;
  const { now } = state;
  if (readiness.readyMailboxIds.size === 0 || open.length === 0) return [];

  const dueNow = and(eq(reachEnrollments.status, 'active'), lte(reachEnrollments.nextSendAt, now), claimable(now));
  const readyIds = [...readiness.readyMailboxIds];
  const withReady = open.filter((c) => c.mailboxIds.some((id) => readiness.readyMailboxIds.has(id))).map((c) => c.id);
  const candidates = db
    .select({ id: reachEnrollments.id })
    .from(reachEnrollments)
    .where(
      and(
        inArray(reachEnrollments.campaignId, open.map((c) => c.id)),
        dueNow,
        or(
          inArray(reachEnrollments.mailboxId, readyIds),
          withReady.length > 0 ? and(isNull(reachEnrollments.mailboxId), inArray(reachEnrollments.campaignId, withReady)) : undefined,
        ),
      ),
    )
    .orderBy(asc(reachEnrollments.nextSendAt), asc(reachEnrollments.id))
    .limit(Math.min(CLAIM_MAX, Math.max(4, readyIds.length * 3)));

  const claimed = await db
    .update(reachEnrollments)
    .set({ claimedAt: now, updatedAt: now })
    .where(and(inArray(reachEnrollments.id, candidates), dueNow))
    .returning();
  return claimed.sort((a, b) => (a.nextSendAt?.getTime() ?? 0) - (b.nextSendAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Triage: what can be settled without sending
// ---------------------------------------------------------------------------

/** What the message rows say about the step an enrollment is on. */
interface StepHistory {
  sentOrUnknown: ReachMessage | null;
  inFlight: boolean;
  failedAttempts: number;
  /** Earlier emails of the sequence, oldest first. */
  previous: ReachMessage[];
}

function historyFor(enrollmentId: string, stepId: string, rows: readonly ReachMessage[]): StepHistory {
  const mine = rows.filter((m) => m.enrollmentId === enrollmentId);
  const forStep = mine.filter((m) => m.stepId === stepId);
  return {
    sentOrUnknown: forStep.find((m) => m.status === 'sent' || m.status === 'unknown') ?? null,
    inFlight: forStep.some((m) => m.status === 'sending'),
    failedAttempts: forStep.filter((m) => m.status === 'failed').length,
    previous: mine.filter((m) => m.status === 'sent' || m.status === 'unknown'),
  };
}

function stepOf(state: TickState, e: ReachEnrollment): ReachCampaignStep | undefined {
  return state.steps.get(e.campaignId)?.find((s) => s.order === e.currentStep);
}

/** The enrollment moves to its next step (or completes) after `message` went out from `mailboxId`. */
function advance(state: TickState, e: ReachEnrollment, message: Pick<ReachMessage, 'id' | 'messageIdHeader'>, mailboxId: string): EnrollmentPatch {
  const campaign = state.campaigns.get(e.campaignId) as ReachCampaign;
  const next = state.steps.get(e.campaignId)?.find((s) => s.order === e.currentStep + 1);
  const base: EnrollmentPatch = {
    currentStep: e.currentStep + 1,
    mailboxId,
    lastMessageId: message.id,
    threadRootMessageId: e.threadRootMessageId ?? message.messageIdHeader,
    claimedAt: null,
    updatedAt: state.now,
  };
  if (!next) return { ...base, status: 'completed', nextSendAt: null };
  return { ...base, status: 'active', nextSendAt: nextStepDueAt(state.now, next, scheduleOf(campaign)) };
}

function stop(state: TickState, status: ReachEnrollment['status'], reason: string | null): EnrollmentPatch {
  return { status, stoppedReason: reason, nextSendAt: null, claimedAt: null, updatedAt: state.now };
}

function putBack(state: TickState, until: Date | null): EnrollmentPatch {
  return { claimedAt: null, ...(until ? { nextSendAt: until } : {}), updatedAt: state.now };
}

interface Triage {
  patches: Map<string, EnrollmentPatch>;
  toPlan: ReachEnrollment[];
  prospects: Map<string, ReachProspect>;
  history: ReachMessage[];
}

/**
 * What triage decided about one claimed enrollment that needs no send: the
 * patch that settles it, and which tally it counts toward (if any).
 */
interface Settlement {
  patch: EnrollmentPatch;
  counts?: 'failed' | 'deferred';
}

function failed(state: TickState, reason: string): Settlement {
  return { patch: stop(state, 'failed', reason), counts: 'failed' };
}

/**
 * Settle a claimed enrollment that does not need a send: a prospect that is
 * gone, a step that already went out, an address that became suppressed.
 * null when it is still to be planned.
 */
function settleWithoutSending(
  state: TickState,
  e: ReachEnrollment,
  prospect: ReachProspect | undefined,
  history: readonly ReachMessage[],
  suppression: SuppressionIndex,
): Settlement | null {
  const step = stepOf(state, e);
  if (!prospect || prospect.deletedAt) return failed(state, 'prospect_deleted');
  if (!step) return { patch: stop(state, 'completed', null) };
  const past = historyFor(e.id, step.id, history);
  if (past.sentOrUnknown) {
    // A crash between the SMTP reply and the enrollment update: the step is out already.
    return { patch: advance(state, e, past.sentOrUnknown, past.sentOrUnknown.mailboxId) };
  }
  if (past.inFlight) return { patch: putBack(state, after(state.now, IN_FLIGHT_RETRY_MS)), counts: 'deferred' };
  if (past.failedAttempts >= MAX_SEND_ATTEMPTS) return failed(state, 'send_failed');
  const hit = suppression.check(prospect.email);
  if (hit) {
    return { patch: stop(state, hit.reason === 'bounced' ? 'bounced' : 'unsubscribed', `suppressed:${hit.reason}`) };
  }
  if (!state.deps.limits.allowConsumerRecipients && isConsumerEmail(prospect.email)) return failed(state, 'consumer_domain');
  // Whatever the prospect lacks is known now; the sender's own name is always set.
  const probe = buildTemplateValues(prospect, { firstName: 'sender', lastName: 'sender' });
  if (renderStepContent(step, probe).missing.length > 0) return failed(state, 'missing_variables');
  return null;
}

/**
 * Settle claimed enrollments that do not need a send: a prospect that is gone,
 * a step that already went out, an address that became suppressed. What is
 * left is planned.
 */
async function triage(state: TickState, claimed: ReachEnrollment[], tally: TickResult): Promise<Triage> {
  const { db } = state.deps;
  const prospectRows = await db
    .select()
    .from(reachProspects)
    .where(inArray(reachProspects.id, [...new Set(claimed.map((e) => e.prospectId))]));
  const history = await db
    .select()
    .from(reachMessages)
    .where(
      and(
        inArray(reachMessages.enrollmentId, claimed.map((e) => e.id)),
        eq(reachMessages.direction, 'out'),
        inArray(reachMessages.status, ['sending', 'sent', 'unknown', 'failed']),
      ),
    )
    .orderBy(asc(reachMessages.createdAt), asc(reachMessages.id));
  const suppression = await loadSuppressionIndex(
    db,
    prospectRows.map((p) => p.email),
  );

  const prospects = new Map(prospectRows.map((p) => [p.id, p]));
  const patches = new Map<string, EnrollmentPatch>();
  const toPlan: ReachEnrollment[] = [];

  for (const e of claimed) {
    const settled = settleWithoutSending(state, e, prospects.get(e.prospectId), history, suppression);
    if (!settled) {
      toPlan.push(e);
      continue;
    }
    patches.set(e.id, settled.patch);
    if (settled.counts) tally[settled.counts] += 1;
  }
  return { patches, toPlan, prospects, history };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

interface SendOneInput {
  deps: TickDeps;
  now: Date;
  enrollment: ReachEnrollment;
  prospect: ReachProspect;
  mailbox: MailboxRow;
  step: ReachCampaignStep;
  firstStep: ReachCampaignStep;
  history: StepHistory;
}

async function sendOne(input: SendOneInput): Promise<Outcome> {
  const { deps, now, enrollment, prospect, mailbox, step, firstStep, history } = input;
  const { db, env } = deps;

  // Reserve the mailbox: the gap restarts now, and a tick that raced us for the
  // same mailbox finds its `last_sent_at` changed and backs off.
  const reserved = await db
    .update(reachMailboxes)
    .set({ lastSentAt: now, updatedAt: now })
    .where(
      and(
        eq(reachMailboxes.id, mailbox.id),
        eq(reachMailboxes.status, 'active'),
        mailbox.lastSentAt
          ? sql`date_trunc('milliseconds', ${reachMailboxes.lastSentAt}) = ${mailbox.lastSentAt.toISOString()}::timestamptz`
          : isNull(reachMailboxes.lastSentAt),
      ),
    )
    .returning({ id: reachMailboxes.id });
  if (reserved.length === 0) return { kind: 'busy' };

  const values = buildTemplateValues(prospect, { firstName: mailbox.firstName, lastName: mailbox.lastName });
  const rendered = renderStepContent(step, values);
  if (rendered.missing.length > 0) return { kind: 'missing_variables' };

  let subject = rendered.subject;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let threadKey: string | null = null;
  if (step.order > 0 && step.replyInThread && history.previous.length > 0) {
    const root = renderStepContent(firstStep, values);
    subject = replySubject(root.missing.length === 0 ? root.subject : rendered.subject);
    references = history.previous.map((m) => m.messageIdHeader);
    inReplyTo = references[references.length - 1] ?? null;
    threadKey = enrollment.threadRootMessageId ?? references[0] ?? null;
  }

  const fullName = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ').trim();
  const sent = await sendFromMailbox(
    { env, db, connect: deps.connect, now: deps.now },
    {
      mailboxId: mailbox.id,
      to: { email: prospect.email, name: fullName === '' ? undefined : fullName },
      subject,
      text: composeBody(rendered.body, mailbox.signature),
      appendFooter: true,
      inReplyTo,
      references,
      threadKey,
      campaignId: enrollment.campaignId,
      enrollmentId: enrollment.id,
      stepId: step.id,
      prospectId: prospect.id,
    },
  );

  if (sent.ok) return { kind: 'sent', message: sent.message };
  if (!sent.message) {
    return { kind: 'mailbox_unusable', error: sent.error, credentialsMissing: sent.error === CREDENTIALS_UNAVAILABLE };
  }
  if (sent.message.status === 'unknown') return { kind: 'uncertain', message: sent.message };
  if (sent.recipientRejected) return { kind: 'bounced', message: sent.message };
  if (sent.authFailed) return { kind: 'auth_failed', error: sent.error };
  return sent.permanent ? { kind: 'rejected' } : { kind: 'temporary' };
}

interface SendRun {
  send: PlannedSend;
  enrollment: ReachEnrollment;
  mailbox: MailboxRow;
  outcome: Outcome;
}

async function executeSends(state: TickState, sends: PlannedSend[], claimed: ReachEnrollment[], t: Triage): Promise<SendRun[]> {
  const enrollmentById = new Map(claimed.map((e) => [e.id, e]));
  return mapLimited(sends, SEND_CONCURRENCY, async (send) => {
    const enrollment = enrollmentById.get(send.enrollmentId) as ReachEnrollment;
    const mailbox = state.mailboxes.get(send.mailboxId) as MailboxRow;
    const step = stepOf(state, enrollment) as ReachCampaignStep;
    const steps = state.steps.get(enrollment.campaignId) ?? [];
    let outcome: Outcome;
    try {
      outcome = await sendOne({
        deps: state.deps,
        now: state.now,
        enrollment,
        prospect: t.prospects.get(enrollment.prospectId) as ReachProspect,
        mailbox,
        step,
        firstStep: steps.find((s) => s.order === 0) ?? step,
        history: historyFor(enrollment.id, step.id, t.history),
      });
    } catch (err) {
      console.error('[reach-send] send failed unexpectedly:', err);
      outcome = { kind: 'temporary' };
    }
    return { send, enrollment, mailbox, outcome };
  });
}

// ---------------------------------------------------------------------------
// Apply the results
// ---------------------------------------------------------------------------

interface Applied {
  patches: Map<string, EnrollmentPatch>;
  statsDelta: Map<string, { sent: number; bounced: number }>;
  bounced: Array<{ mailboxId: string; campaignId: string }>;
  mailboxProblems: Map<string, { pausedReason: string; lastError: string }>;
  /** A mailbox was busy: look again soon. */
  retrySoon: boolean;
}

async function applyOutcomes(state: TickState, runs: SendRun[], t: Triage, tally: TickResult): Promise<Applied> {
  const { db } = state.deps;
  const { now } = state;
  const applied: Applied = {
    patches: t.patches,
    statsDelta: new Map(),
    bounced: [],
    mailboxProblems: new Map(),
    retrySoon: false,
  };
  const bump = (campaignId: string, key: 'sent' | 'bounced') => {
    const cur = applied.statsDelta.get(campaignId) ?? { sent: 0, bounced: 0 };
    cur[key] += 1;
    applied.statsDelta.set(campaignId, cur);
  };
  const defer = (id: string, until: Date | null) => {
    applied.patches.set(id, putBack(state, until));
    tally.deferred += 1;
  };

  for (const { enrollment: e, outcome, mailbox } of runs) {
    switch (outcome.kind) {
      case 'sent':
        applied.patches.set(e.id, advance(state, e, outcome.message, mailbox.id));
        tally.sent += 1;
        bump(e.campaignId, 'sent');
        break;
      case 'uncertain':
        // Maybe delivered: never send it again, carry on with the sequence.
        applied.patches.set(e.id, advance(state, e, outcome.message, mailbox.id));
        break;
      case 'bounced': {
        applied.patches.set(e.id, { ...stop(state, 'bounced', 'hard_bounce'), mailboxId: mailbox.id, lastMessageId: outcome.message.id });
        tally.bounced += 1;
        bump(e.campaignId, 'bounced');
        applied.bounced.push({ mailboxId: mailbox.id, campaignId: e.campaignId });
        const prospect = t.prospects.get(e.prospectId) as ReachProspect;
        await suppressEmail(db, prospect.email, 'bounced', outcome.message.id);
        break;
      }
      case 'rejected':
        applied.patches.set(e.id, stop(state, 'failed', 'smtp_rejected'));
        tally.failed += 1;
        break;
      case 'missing_variables':
        applied.patches.set(e.id, stop(state, 'failed', 'missing_variables'));
        tally.failed += 1;
        break;
      case 'auth_failed':
        applied.mailboxProblems.set(mailbox.id, { pausedReason: 'smtp_auth_failed', lastError: outcome.error });
        defer(e.id, after(now, e.mailboxId ? UNAVAILABLE_RETRY_MS : TEMPORARY_RETRY_MS));
        break;
      case 'mailbox_unusable':
        if (outcome.credentialsMissing) {
          applied.mailboxProblems.set(mailbox.id, { pausedReason: 'credentials_unavailable', lastError: outcome.error });
        }
        defer(e.id, after(now, UNAVAILABLE_RETRY_MS));
        break;
      case 'busy':
        applied.retrySoon = true;
        defer(e.id, null);
        break;
      case 'temporary':
        defer(e.id, after(now, TEMPORARY_RETRY_MS));
        break;
    }
  }
  return applied;
}

async function persist(state: TickState, applied: Applied): Promise<void> {
  const { deps, now } = state;
  const { db } = deps;

  for (const [mailboxId, problem] of applied.mailboxProblems) {
    const [updated] = await db
      .update(reachMailboxes)
      .set({ status: 'error', pausedReason: problem.pausedReason, lastError: problem.lastError.slice(0, 500), updatedAt: now })
      .where(and(eq(reachMailboxes.id, mailboxId), eq(reachMailboxes.status, 'active')))
      .returning({ id: reachMailboxes.id, email: reachMailboxes.email, status: reachMailboxes.status, pausedReason: reachMailboxes.pausedReason });
    if (updated) await publishRaw(deps, 'reach_mailbox', 'updated', updated.id, updated);
  }

  // The patches are the only place an enrollment changes; a reply that arrived
  // meanwhile (status no longer `active`) is never overwritten.
  await mapLimited([...applied.patches.entries()], SEND_CONCURRENCY, ([id, set]) =>
    db
      .update(reachEnrollments)
      .set(set)
      .where(and(eq(reachEnrollments.id, id), eq(reachEnrollments.status, 'active'))),
  );

  for (const [campaignId, delta] of applied.statsDelta) await addToCampaignStats(db, campaignId, delta);
  const hooks = guardrailHooks(deps);
  for (const target of applied.bounced) await recordHardBounce(db, target, hooks, now);
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

/** Complete finished campaigns, then work out when this workspace next has work. */
async function finishTick(state: TickState, retryAt: Date | null): Promise<Date | null> {
  const { deps, now } = state;
  const { db } = deps;
  const completed = await completeFinishedCampaigns(db, [...state.campaigns.keys()]);
  for (const c of completed) await publishRaw(deps, 'reach_campaign', 'completed', c.id, { ...c });

  const [row] = await db
    .select({ at: min(reachEnrollments.nextSendAt) })
    .from(reachEnrollments)
    .innerJoin(reachCampaigns, eq(reachCampaigns.id, reachEnrollments.campaignId))
    .where(
      and(
        eq(reachEnrollments.status, 'active'),
        eq(reachCampaigns.status, 'active'),
        isNull(reachCampaigns.deletedAt),
        isNotNull(reachEnrollments.nextSendAt),
      ),
    );
  const earliest = row?.at ?? null;
  if (!earliest) return null;
  if (earliest.getTime() > now.getTime()) return earliest;

  // Something is due but could not go out this tick (a gap, a busy mailbox, rows beyond the claim limit).
  if (!retryAt) return after(now, MIN_RETRY_MS);
  const floor = after(now, RETRY_FLOOR_MS);
  return retryAt.getTime() > floor.getTime() ? retryAt : floor;
}

export async function runSendTick(deps: TickDeps): Promise<TickResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const tally: TickResult = { claimed: 0, sent: 0, bounced: 0, failed: 0, deferred: 0, nextDueAt: null };

  await markStuckSendingMessages(db, now);

  const campaignRows = await db
    .select()
    .from(reachCampaigns)
    .where(and(eq(reachCampaigns.status, 'active'), isNull(reachCampaigns.deletedAt)));
  if (campaignRows.length === 0) return tally;

  const state = await loadTickState(deps, now, campaignRows);
  const { open, readiness } = await deferUnsendable(state);
  const claimed = await claimDue(state, open, readiness);
  tally.claimed = claimed.length;

  let retryAt = readiness.gapBlockedUntil;
  if (claimed.length > 0) {
    const t = await triage(state, claimed, tally);
    const plan = planSends(
      state.ctx,
      state.planCampaigns,
      state.planMailboxes,
      t.toPlan.map<PlanEnrollment>((e) => ({ id: e.id, campaignId: e.campaignId, mailboxId: e.mailboxId })),
    );
    for (const d of plan.deferrals) {
      t.patches.set(d.enrollmentId, putBack(state, d.until));
      tally.deferred += 1;
    }
    const runs = await executeSends(state, plan.sends, claimed, t);
    const applied = await applyOutcomes(state, runs, t, tally);
    await persist(state, applied);

    const candidates = [retryAt, plan.retryAt, applied.retrySoon ? after(now, MIN_RETRY_MS) : null].filter((d): d is Date => d !== null);
    retryAt = candidates.length > 0 ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  }

  tally.nextDueAt = await finishTick(state, retryAt);
  return tally;
}

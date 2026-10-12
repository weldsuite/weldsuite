/**
 * Campaign reads and the state changes shared by the routes, the send
 * consumer and the reply handler.
 *
 * A campaign is `draft` until launched, `active` while it sends, `paused`
 * (by a user, or automatically: `pausedReason`), and `completed` once no
 * enrollment is queued or active any more.
 */

import { and, asc, desc, eq, inArray, isNull, min, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import {
  WELDREACH_SENDING_DEFAULTS,
  type ReachCampaign,
  type ReachCampaignDetail,
  type ReachCampaignStats,
  type ReachCampaignStepStats,
  type ReachCampaignStep,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMessages,
  reachSettings,
  type ReachCampaign as ReachCampaignRow,
  type ReachCampaignStep as ReachCampaignStepRow,
  type ReachSettings as ReachSettingsRow,
} from '@weldsuite/db/schema';
import { isValidTimeZone, parseHHMM, spreadSendTimes, type SendSchedule } from '../lib/send-window';
import { bulkSetNextSendAt, countActiveCampaignMailboxes, countCampaignEnrollments } from './enrollments';

export function toCampaign(row: ReachCampaignRow): ReachCampaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    sendDays: row.sendDays,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    dailyLimit: row.dailyLimit,
    minGapMinutes: row.minGapMinutes,
    stopOnAutoReply: row.stopOnAutoReply,
    stats: row.stats,
    pausedReason: row.pausedReason,
    launchedAt: row.launchedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toStep(row: ReachCampaignStepRow): ReachCampaignStep {
  return {
    id: row.id,
    order: row.order,
    delayDays: row.delayDays,
    delayHours: row.delayHours,
    subject: row.subject,
    body: row.body,
    replyInThread: row.replyInThread,
  };
}

export function scheduleOf(row: Pick<ReachCampaignRow, 'timezone' | 'sendDays' | 'windowStart' | 'windowEnd'>): SendSchedule {
  return { timezone: row.timezone, sendDays: row.sendDays, windowStart: row.windowStart, windowEnd: row.windowEnd };
}

export async function loadReachSettings(db: Database): Promise<ReachSettingsRow | null> {
  const [row] = await db.select().from(reachSettings).limit(1);
  return row ?? null;
}

export async function findCampaign(db: Database, id: string): Promise<ReachCampaignRow | null> {
  const [row] = await db
    .select()
    .from(reachCampaigns)
    .where(and(eq(reachCampaigns.id, id), isNull(reachCampaigns.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function loadSteps(db: Database, campaignId: string): Promise<ReachCampaignStepRow[]> {
  return db
    .select()
    .from(reachCampaignSteps)
    .where(eq(reachCampaignSteps.campaignId, campaignId))
    .orderBy(asc(reachCampaignSteps.order));
}

export async function loadCampaignMailboxIds(db: Database, campaignId: string): Promise<string[]> {
  const rows = await db
    .select({ mailboxId: reachCampaignMailboxes.mailboxId })
    .from(reachCampaignMailboxes)
    .where(eq(reachCampaignMailboxes.campaignId, campaignId));
  return rows.map((r) => r.mailboxId);
}

export async function loadCampaignDetail(db: Database, id: string): Promise<ReachCampaignDetail | null> {
  const campaign = await findCampaign(db, id);
  if (!campaign) return null;
  const [steps, mailboxIds] = await Promise.all([loadSteps(db, id), loadCampaignMailboxIds(db, id)]);
  return { ...toCampaign(campaign), steps: steps.map(toStep), mailboxIds };
}

/** Schedule fields a new campaign starts with: the workspace defaults, else the table defaults. */
export function campaignDefaults(settings: ReachSettingsRow | null) {
  if (!settings) return {};
  return {
    timezone: settings.defaultTimezone,
    sendDays: settings.defaultSendDays,
    windowStart: settings.defaultWindowStart,
    windowEnd: settings.defaultWindowEnd,
    minGapMinutes: WELDREACH_SENDING_DEFAULTS.minGapMinutes,
  };
}

/** A message for a schedule that cannot work, or null. */
export function scheduleProblem(s: Pick<SendSchedule, 'timezone' | 'windowStart' | 'windowEnd'>): string | null {
  if (!isValidTimeZone(s.timezone)) return `Unknown timezone '${s.timezone}'`;
  const start = parseHHMM(s.windowStart);
  const end = parseHHMM(s.windowEnd);
  if (start === null || end === null) return 'The sending window must be HH:MM';
  if (end <= start) return 'The sending window must end after it starts';
  return null;
}

export const emptyStats: ReachCampaignStats = {
  prospects: 0,
  sent: 0,
  replied: 0,
  interested: 0,
  bounced: 0,
  unsubscribed: 0,
};

/** Add `delta` to the campaign's denormalised counters in one atomic UPDATE. */
export async function addToCampaignStats(
  db: Database,
  campaignId: string,
  delta: Partial<ReachCampaignStats>,
): Promise<void> {
  const keys = (Object.keys(delta) as Array<keyof ReachCampaignStats>).filter((k) => (delta[k] ?? 0) !== 0);
  if (keys.length === 0) return;
  const patch = sql.join(
    keys.map(
      (k) =>
        sql`${sql.raw(`'${k}'`)}, coalesce((${reachCampaigns.stats}->>${sql.raw(`'${k}'`)})::int, 0) + ${delta[k] ?? 0}`,
    ),
    sql`, `,
  );
  await db
    .update(reachCampaigns)
    .set({ stats: sql`${reachCampaigns.stats} || jsonb_build_object(${patch})` })
    .where(eq(reachCampaigns.id, campaignId));
}

/** Set `stats.prospects` to the live number of enrollments. */
export async function recountCampaignProspects(db: Database, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachEnrollments)
    .where(eq(reachEnrollments.campaignId, campaignId));
  const n = Number(row?.n ?? 0);
  await db
    .update(reachCampaigns)
    .set({ stats: sql`${reachCampaigns.stats} || jsonb_build_object('prospects', ${n}::int)` })
    .where(eq(reachCampaigns.id, campaignId));
  return n;
}

/**
 * Complete an active campaign that has nothing queued or active left. Returns
 * the campaign when it was completed now (so the caller can publish the
 * `completed` event), null otherwise.
 */
export async function completeCampaignIfDone(db: Database, campaignId: string): Promise<ReachCampaignRow | null> {
  const [pending] = await db
    .select({ id: reachEnrollments.id })
    .from(reachEnrollments)
    .where(and(eq(reachEnrollments.campaignId, campaignId), inArray(reachEnrollments.status, ['queued', 'active'])))
    .limit(1);
  if (pending) return null;
  const now = new Date();
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(reachCampaigns.id, campaignId), eq(reachCampaigns.status, 'active'), isNull(reachCampaigns.deletedAt)))
    .returning();
  return row ?? null;
}

/** `completeCampaignIfDone` over several campaigns; returns the ones completed now. */
export async function completeFinishedCampaigns(db: Database, campaignIds: readonly string[]): Promise<ReachCampaignRow[]> {
  const done: ReachCampaignRow[] = [];
  for (const id of new Set(campaignIds)) {
    const row = await completeCampaignIfDone(db, id);
    if (row) done.push(row);
  }
  return done;
}

export interface ActivationResult {
  activated: number;
  /** When the first activated enrollment is due. */
  earliest: Date | null;
}

/**
 * Queued enrollments become active, due one after another over the next
 * sending window (the per-mailbox caps and gaps decide the real pace).
 */
export async function activateQueuedEnrollments(
  db: Database,
  campaign: Pick<ReachCampaignRow, 'id' | 'timezone' | 'sendDays' | 'windowStart' | 'windowEnd' | 'minGapMinutes'>,
  now: Date = new Date(),
): Promise<ActivationResult> {
  const queued = await db
    .select({ id: reachEnrollments.id })
    .from(reachEnrollments)
    .where(and(eq(reachEnrollments.campaignId, campaign.id), eq(reachEnrollments.status, 'queued')))
    .orderBy(asc(reachEnrollments.createdAt), asc(reachEnrollments.id));
  if (queued.length === 0) return { activated: 0, earliest: null };

  const times = spreadSendTimes(queued.length, now, scheduleOf(campaign), campaign.minGapMinutes * 60_000);
  await bulkSetNextSendAt(
    db,
    queued.map((q, i) => ({ id: q.id, at: times[i] as Date })),
    { status: 'active', now },
  );
  return { activated: queued.length, earliest: times[0] ?? null };
}

export type LaunchProblem = 'no_steps' | 'no_active_mailbox' | 'no_sender_identity' | 'no_prospects';

/**
 * What stops a campaign from launching, or an empty list when it can go.
 * A mailbox that is still warming may be assigned but does not count: only an
 * `active` one can send.
 */
export async function launchProblems(db: Database, campaignId: string): Promise<LaunchProblem[]> {
  const [steps, activeMailboxes, queued, settings] = await Promise.all([
    db
      .select({ id: reachCampaignSteps.id })
      .from(reachCampaignSteps)
      .where(eq(reachCampaignSteps.campaignId, campaignId))
      .limit(1),
    countActiveCampaignMailboxes(db, campaignId),
    countCampaignEnrollments(db, campaignId, 'queued'),
    loadReachSettings(db),
  ]);
  const problems: LaunchProblem[] = [];
  if (steps.length === 0) problems.push('no_steps');
  if (activeMailboxes === 0) problems.push('no_active_mailbox');
  if (!settings?.senderCompanyName?.trim() || !settings.senderAddress?.trim()) problems.push('no_sender_identity');
  if (queued === 0) problems.push('no_prospects');
  return problems;
}

/** When the campaign's earliest active enrollment is due (null when it has none). */
export async function earliestDueAt(db: Database, campaignId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(reachEnrollments.nextSendAt) })
    .from(reachEnrollments)
    .where(and(eq(reachEnrollments.campaignId, campaignId), eq(reachEnrollments.status, 'active')));
  return row?.at ?? null;
}

/**
 * Per-step numbers for the campaign page. A reply or a bounce belongs to the
 * step of the last email that went to that prospect.
 */
export async function campaignStepStats(db: Database, campaignId: string): Promise<ReachCampaignStepStats[]> {
  const steps = await loadSteps(db, campaignId);
  const [sentRows, outcomeRows] = await Promise.all([
    db
      .select({ stepId: reachMessages.stepId, n: sql<number>`count(*)::int` })
      .from(reachMessages)
      .where(and(eq(reachMessages.campaignId, campaignId), eq(reachMessages.direction, 'out'), eq(reachMessages.status, 'sent')))
      .groupBy(reachMessages.stepId),
    db
      .selectDistinctOn([reachMessages.enrollmentId], {
        stepId: reachMessages.stepId,
        enrollmentStatus: reachEnrollments.status,
      })
      .from(reachMessages)
      .innerJoin(reachEnrollments, eq(reachEnrollments.id, reachMessages.enrollmentId))
      .where(
        and(
          eq(reachMessages.campaignId, campaignId),
          eq(reachMessages.direction, 'out'),
          inArray(reachEnrollments.status, ['replied', 'bounced']),
          inArray(reachMessages.status, ['sent', 'unknown', 'failed']),
        ),
      )
      .orderBy(reachMessages.enrollmentId, desc(reachMessages.createdAt)),
  ]);

  const sent = new Map(sentRows.map((r) => [r.stepId, Number(r.n)]));
  const replied = new Map<string, number>();
  const bounced = new Map<string, number>();
  for (const row of outcomeRows) {
    if (!row.stepId) continue;
    const bucket = row.enrollmentStatus === 'replied' ? replied : bounced;
    bucket.set(row.stepId, (bucket.get(row.stepId) ?? 0) + 1);
  }
  return steps.map((s) => ({
    stepId: s.id,
    order: s.order,
    sent: sent.get(s.id) ?? 0,
    replied: replied.get(s.id) ?? 0,
    bounced: bounced.get(s.id) ?? 0,
  }));
}

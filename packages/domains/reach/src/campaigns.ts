/**
 * Campaigns: the reads, the state changes shared by the routes, the send
 * consumer and the reply handler, and the operations an API exposes (create,
 * edit, steps, mailboxes, enrol, launch, pause, resume, preview, stats).
 *
 * A campaign is `draft` until launched, `active` while it sends, `paused`
 * (by a user, or automatically: `pausedReason`), and `completed` once no
 * enrollment is queued or active any more.
 *
 * Sending itself happens in the `reach-send` queue consumer. The operations
 * here only change state, then wake the sweep through `deps.onDue` and tell
 * the world through `deps.emit` (`reach_campaign` created / updated / deleted
 * / launched / paused / completed).
 */

import { and, asc, desc, eq, ilike, inArray, isNull, min, ne, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  reachCampaignStatusSchema,
  reachEnrollmentStatusSchema,
  WELDREACH_SENDING_DEFAULTS,
  type AddReachCampaignProspectsInput,
  type CreateReachCampaignInput,
  type ReachAddProspectsReport,
  type ReachCampaign,
  type ReachCampaignDetail,
  type ReachCampaignStats,
  type ReachCampaignStepStats,
  type ReachCampaignStep,
  type ReachEnrollment,
  type ReachRenderedPreview,
  type ReachStepInput,
  type UpdateReachCampaignInput,
  type WeldReachLimits,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  reachSettings,
  type ReachCampaign as ReachCampaignRow,
  type ReachCampaignStep as ReachCampaignStepRow,
  type ReachProspect as ReachProspectRow,
  type ReachSettings as ReachSettingsRow,
} from '@weldsuite/db/schema';
import { completeAndPublishCampaigns } from './campaign-completion';
import {
  addProspectsToCampaign,
  bulkSetNextSendAt,
  countActiveCampaignMailboxes,
  countCampaignEnrollments,
  listCampaignEnrollments,
  removeEnrollment,
  toEnrollment,
} from './enrollments';
import { reachError } from './errors';
import type { ReachDuePort, ReachEventSink } from './events';
import { cursorCondition, likePattern, pageResult, parseLimit, type Page, type PageQuery } from './list-query';
import { findList } from './lists';
import { buildEmailFooter, buildTemplateValues, composeBody, renderStepContent } from './render';
import { isValidTimeZone, parseHHMM, spreadSendTimes, type SendSchedule } from './send-window';

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
    keys.map((k) => {
      const key = sql.raw(`'${k}'`);
      return sql`${key}, coalesce((${reachCampaigns.stats}->>${key})::int, 0) + ${delta[k] ?? 0}`;
    }),
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface CampaignDeps {
  db: Database;
  emit: ReachEventSink;
}

/** Creating a campaign records who owns it. */
export interface CreateCampaignDeps extends CampaignDeps {
  userId: string;
}

/** Operations that put outreach on the clock wake the send sweep. */
export interface CampaignSendDeps extends CampaignDeps {
  onDue?: ReachDuePort;
}

export interface EnrollDeps extends CampaignSendDeps {
  /** The workspace's resolved limits (`resolveWeldReachLimits`): consumer addresses may be refused. */
  limits: Pick<WeldReachLimits, 'allowConsumerRecipients'>;
}

async function emitCampaign(
  emit: ReachEventSink,
  action: 'created' | 'updated' | 'deleted' | 'launched' | 'paused' | 'completed',
  row: Pick<ReachCampaignRow, 'id'> & Partial<ReachCampaignRow>,
): Promise<void> {
  await emit({ entityType: 'reach_campaign', action, entityId: row.id, data: row });
}

/** Tell the send sweep when this workspace next has outreach due. */
async function wake(deps: Pick<CampaignSendDeps, 'onDue'>, at: Date | null): Promise<void> {
  const now = new Date();
  await deps.onDue?.('reach_send', at && at.getTime() > now.getTime() ? at : now);
}

async function requireCampaign(db: Database, id: string): Promise<ReachCampaignRow> {
  const campaign = await findCampaign(db, id);
  if (!campaign) throw reachError.notFound('Campaign', id);
  return campaign;
}

/** One campaign with its steps and mailboxes; throws 404 when it does not exist. */
export async function getCampaignDetail(db: Database, id: string): Promise<ReachCampaignDetail> {
  const detail = await loadCampaignDetail(db, id);
  if (!detail) throw reachError.notFound('Campaign', id);
  return detail;
}

export interface ListCampaignsQuery extends PageQuery {
  status?: string;
  search?: string;
}

export async function listCampaigns(db: Database, q: ListCampaignsQuery = {}): Promise<Page<ReachCampaign>> {
  const limit = parseLimit(q.limit);

  const conditions = [isNull(reachCampaigns.deletedAt)];
  if (q.status) {
    const parsed = reachCampaignStatusSchema.safeParse(q.status);
    if (!parsed.success) throw reachError.badRequest('Unknown status filter');
    conditions.push(eq(reachCampaigns.status, parsed.data));
  }
  if (q.search?.trim()) conditions.push(ilike(reachCampaigns.name, likePattern(q.search)));

  const after = await cursorCondition(db, reachCampaigns, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachCampaigns)
      .where(and(...conditions, after))
      .orderBy(desc(reachCampaigns.createdAt), desc(reachCampaigns.id))
      .limit(limit + 1),
    db.$count(reachCampaigns, and(...conditions)),
  ]);
  return pageResult(rows, limit, total, toCampaign);
}

export async function createCampaign(deps: CreateCampaignDeps, input: CreateReachCampaignInput): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const defaults = campaignDefaults(await loadReachSettings(db));
  const merged = { ...defaults, ...input };

  const problem = scheduleProblem({
    timezone: merged.timezone ?? 'Europe/Amsterdam',
    windowStart: merged.windowStart ?? '09:00',
    windowEnd: merged.windowEnd ?? '17:00',
  });
  if (problem) throw reachError.badRequest(problem);

  const [row] = await db
    .insert(reachCampaigns)
    .values({
      id: generateId('rcmp'),
      ...merged,
      status: 'draft',
      stats: emptyStats,
      ownerId: deps.userId,
      createdBy: deps.userId,
    })
    .returning();
  if (!row) throw reachError.internal('Failed to create the campaign');
  await emitCampaign(deps.emit, 'created', row);
  return { ...toCampaign(row), steps: [], mailboxIds: [] };
}

export async function updateCampaign(deps: CampaignDeps, id: string, input: UpdateReachCampaignInput): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const current = await requireCampaign(db, id);

  const problem = scheduleProblem({
    timezone: input.timezone ?? current.timezone,
    windowStart: input.windowStart ?? current.windowStart,
    windowEnd: input.windowEnd ?? current.windowEnd,
  });
  if (problem) throw reachError.badRequest(problem);

  const [row] = await db
    .update(reachCampaigns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(reachCampaigns.id, id), isNull(reachCampaigns.deletedAt)))
    .returning();
  if (!row) throw reachError.notFound('Campaign', id);
  await emitCampaign(deps.emit, 'updated', row);
  return getCampaignDetail(db, id);
}

export async function deleteCampaign(deps: CampaignDeps, id: string): Promise<void> {
  const { db } = deps;
  const current = await requireCampaign(db, id);
  if (current.status === 'active') throw reachError.state('CAMPAIGN_ACTIVE', 'Pause the campaign before deleting it');

  const now = new Date();
  await db
    .update(reachCampaigns)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(reachCampaigns.id, id));
  // Its prospects are free to join another campaign.
  await db
    .update(reachEnrollments)
    .set({ status: 'paused', stoppedReason: 'campaign_deleted', claimedAt: null, nextSendAt: null, updatedAt: now })
    .where(and(eq(reachEnrollments.campaignId, id), inArray(reachEnrollments.status, ['queued', 'active'])));
  await emitCampaign(deps.emit, 'deleted', { id });
}

/** Replace the whole step list (by position); a running campaign has to be paused first. */
export async function replaceCampaignSteps(deps: CampaignDeps, id: string, steps: readonly ReachStepInput[]): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const campaign = await requireCampaign(db, id);
  if (campaign.status === 'active') throw reachError.state('CAMPAIGN_ACTIVE', 'Pause the campaign before changing its steps');

  // Steps keep their id by position, so the per-step history of an edited step stays attached.
  const existing = await loadSteps(db, id);
  const byOrder = new Map(existing.map((s) => [s.order, s]));
  const now = new Date();
  await atomically(db, (h) => {
    const statements: unknown[] = steps.map((step, order) => {
      const previous = byOrder.get(order);
      return previous
        ? h.update(reachCampaignSteps).set({ ...step, updatedAt: now }).where(eq(reachCampaignSteps.id, previous.id))
        : h.insert(reachCampaignSteps).values({ id: generateId('rstp'), campaignId: id, order, ...step });
    });
    const surplus = existing.filter((s) => s.order >= steps.length).map((s) => s.id);
    if (surplus.length > 0) statements.push(h.delete(reachCampaignSteps).where(inArray(reachCampaignSteps.id, surplus)));
    return statements;
  });
  await emitCampaign(deps.emit, 'updated', campaign);
  return getCampaignDetail(db, id);
}

/** Replace the mailboxes a campaign sends from. */
export async function setCampaignMailboxes(deps: CampaignDeps, id: string, mailboxIdsInput: readonly string[]): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const mailboxIds = [...new Set(mailboxIdsInput)];
  const campaign = await requireCampaign(db, id);

  if (mailboxIds.length > 0) {
    const found = await db
      .select({ id: reachMailboxes.id })
      .from(reachMailboxes)
      .where(and(inArray(reachMailboxes.id, mailboxIds), isNull(reachMailboxes.deletedAt), ne(reachMailboxes.status, 'deleted')));
    const known = new Set(found.map((m) => m.id));
    const unknown = mailboxIds.filter((m) => !known.has(m));
    if (unknown.length > 0) throw reachError.badRequest('Some mailboxes do not exist', { unknown });
  }

  await atomically(db, (h) => [
    h.delete(reachCampaignMailboxes).where(eq(reachCampaignMailboxes.campaignId, id)),
    ...(mailboxIds.length > 0
      ? [h.insert(reachCampaignMailboxes).values(mailboxIds.map((mailboxId) => ({ id: generateId('rcmb'), campaignId: id, mailboxId })))]
      : []),
  ]);
  await emitCampaign(deps.emit, 'updated', campaign);
  return getCampaignDetail(db, id);
}

/**
 * Enrol prospects (by id and / or a whole list). Eligible ones join as
 * `queued`; a running campaign starts them right away and wakes the sweep.
 */
export async function enrollCampaignProspects(
  deps: EnrollDeps,
  id: string,
  input: AddReachCampaignProspectsInput,
): Promise<ReachAddProspectsReport> {
  const { db } = deps;
  const campaign = await requireCampaign(db, id);
  if (campaign.status === 'completed' || campaign.status === 'archived') {
    throw reachError.state('CAMPAIGN_CLOSED', 'This campaign has finished; add the prospects to a new campaign');
  }
  if (input.listId && !(await findList(db, input.listId))) throw reachError.notFound('List', input.listId);

  const { report } = await addProspectsToCampaign(db, id, input, { allowConsumer: deps.limits.allowConsumerRecipients });
  await recountCampaignProspects(db, id);

  if (campaign.status === 'active' && report.added > 0) {
    const { earliest } = await activateQueuedEnrollments(db, campaign);
    await wake(deps, earliest);
  }
  await emitCampaign(deps.emit, 'updated', campaign);
  return report;
}

export interface ListEnrollmentsQuery extends PageQuery {
  status?: string;
}

export async function listEnrollments(db: Database, campaignId: string, q: ListEnrollmentsQuery = {}): Promise<Page<ReachEnrollment>> {
  await requireCampaign(db, campaignId);
  const limit = parseLimit(q.limit);

  let status;
  if (q.status) {
    const parsed = reachEnrollmentStatusSchema.safeParse(q.status);
    if (!parsed.success) throw reachError.badRequest('Unknown status filter');
    status = parsed.data;
  }
  const after = await cursorCondition(db, reachEnrollments, q.cursor);
  const [rows, total] = await Promise.all([
    listCampaignEnrollments(db, campaignId, { status, cursorCondition: after, limit }),
    countCampaignEnrollments(db, campaignId, status),
  ]);
  return pageResult(
    rows.map((r) => ({ ...r, id: r.row.id })),
    limit,
    total,
    (r) => toEnrollment(r.row, r.prospect, r.mailboxEmail),
  );
}

/** Take one enrollment out of a campaign (its message history stays); completes the campaign when that was the last one. */
export async function removeCampaignEnrollment(deps: CampaignDeps, campaignId: string, enrollmentId: string): Promise<void> {
  const { db } = deps;
  const campaign = await requireCampaign(db, campaignId);
  const removed = await removeEnrollment(db, campaignId, enrollmentId);
  if (!removed) throw reachError.notFound('Enrollment', enrollmentId);
  await recountCampaignProspects(db, campaignId);
  await emitCampaign(deps.emit, 'updated', campaign);
  await completeAndPublishCampaigns(db, deps.emit, [campaignId]);
}

export async function launchCampaign(deps: CampaignSendDeps, id: string): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const campaign = await requireCampaign(db, id);
  if (campaign.status === 'active') throw reachError.state('CAMPAIGN_ACTIVE', 'This campaign is already running');
  if (campaign.status === 'paused') throw reachError.state('CAMPAIGN_PAUSED', 'This campaign is paused; resume it instead');
  if (campaign.status === 'archived') throw reachError.state('CAMPAIGN_CLOSED', 'This campaign is archived');

  const problems = await launchProblems(db, id);
  if (problems.length > 0) throw reachError.badRequest('This campaign cannot be launched yet', { problems });

  // Active enrollments do nothing while the campaign is not active, so they can go first.
  const now = new Date();
  const { earliest } = await activateQueuedEnrollments(db, campaign, now);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'active', launchedAt: campaign.launchedAt ?? now, completedAt: null, pausedReason: null, updatedAt: now })
    .where(and(eq(reachCampaigns.id, id), inArray(reachCampaigns.status, ['draft', 'completed'])))
    .returning();
  if (!row) throw reachError.state('CAMPAIGN_ACTIVE', 'This campaign was changed by someone else');

  await wake(deps, earliest);
  await emitCampaign(deps.emit, 'launched', row);
  return getCampaignDetail(db, id);
}

export async function pauseCampaign(deps: CampaignDeps, id: string): Promise<ReachCampaignDetail> {
  const { db } = deps;
  await requireCampaign(db, id);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'paused', pausedReason: 'manual', updatedAt: new Date() })
    .where(and(eq(reachCampaigns.id, id), eq(reachCampaigns.status, 'active')))
    .returning();
  if (!row) throw reachError.state('CAMPAIGN_NOT_ACTIVE', 'Only a running campaign can be paused');
  await emitCampaign(deps.emit, 'paused', row);
  return getCampaignDetail(db, id);
}

export async function resumeCampaign(deps: CampaignSendDeps, id: string): Promise<ReachCampaignDetail> {
  const { db } = deps;
  const campaign = await requireCampaign(db, id);
  if (campaign.status !== 'paused') throw reachError.state('CAMPAIGN_NOT_PAUSED', 'Only a paused campaign can be resumed');

  const now = new Date();
  // Prospects added while it was paused wait as queued until now.
  const { earliest } = await activateQueuedEnrollments(db, campaign, now);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'active', pausedReason: null, updatedAt: now })
    .where(and(eq(reachCampaigns.id, id), eq(reachCampaigns.status, 'paused')))
    .returning();
  if (!row) throw reachError.state('CAMPAIGN_NOT_PAUSED', 'This campaign was changed by someone else');

  await wake(deps, (await earliestDueAt(db, id)) ?? earliest);
  await emitCampaign(deps.emit, 'updated', row);
  return getCampaignDetail(db, id);
}

export async function getCampaignStats(db: Database, id: string): Promise<ReachCampaignStepStats[]> {
  await requireCampaign(db, id);
  return campaignStepStats(db, id);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewStepInput {
  stepId?: string;
  prospectId?: string;
  /** Preview unsaved text instead of a stored step. */
  subject?: string;
  body?: string;
}

type PreviewTemplateLookup =
  | { ok: true; template: { subject: string; body: string } }
  /** `missingStepId` is the step the request named that does not exist; null when the campaign has no step at all. */
  | { ok: false; missingStepId: string | null };

/** The subject and body to preview: the unsaved text of the request, else the chosen (or first) step. */
async function resolvePreviewTemplate(db: Database, campaignId: string, input: PreviewStepInput): Promise<PreviewTemplateLookup> {
  if (input.subject !== undefined || input.body !== undefined) {
    return { ok: true, template: { subject: input.subject ?? '', body: input.body ?? '' } };
  }
  const steps = await loadSteps(db, campaignId);
  const step = input.stepId ? steps.find((s) => s.id === input.stepId) : steps[0];
  if (!step) return { ok: false, missingStepId: input.stepId || null };
  return { ok: true, template: { subject: step.subject, body: step.body } };
}

async function findLiveProspect(db: Database, id: string): Promise<ReachProspectRow | null> {
  const [row] = await db
    .select()
    .from(reachProspects)
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The oldest live prospect enrolled in the campaign, to fill the preview with real data. */
async function firstEnrolledProspect(db: Database, campaignId: string): Promise<ReachProspectRow | null> {
  const [first] = await db
    .select({ prospect: reachProspects })
    .from(reachEnrollments)
    .innerJoin(reachProspects, eq(reachProspects.id, reachEnrollments.prospectId))
    .where(and(eq(reachEnrollments.campaignId, campaignId), isNull(reachProspects.deletedAt)))
    .orderBy(asc(reachEnrollments.createdAt))
    .limit(1);
  return first?.prospect ?? null;
}

/** The sender whose name and signature fill the preview: the oldest live mailbox of the campaign. */
async function firstCampaignMailbox(db: Database, campaignId: string) {
  const mailboxIds = await loadCampaignMailboxIds(db, campaignId);
  if (mailboxIds.length === 0) return undefined;
  const [mailbox] = await db
    .select({ firstName: reachMailboxes.firstName, lastName: reachMailboxes.lastName, signature: reachMailboxes.signature })
    .from(reachMailboxes)
    .where(and(inArray(reachMailboxes.id, mailboxIds), isNull(reachMailboxes.deletedAt)))
    .orderBy(asc(reachMailboxes.createdAt))
    .limit(1);
  return mailbox;
}

const SAMPLE_PROSPECT = {
  email: 'alex.morgan@example.com',
  firstName: 'Alex',
  lastName: 'Morgan',
  companyName: 'Example Inc',
  title: 'Operations Manager',
  customFields: {},
};

/** A step as it would be sent: to a chosen (or the first enrolled, or a sample) prospect, from the campaign's first mailbox. */
export async function previewCampaignStep(db: Database, id: string, input: PreviewStepInput): Promise<ReachRenderedPreview> {
  await requireCampaign(db, id);

  const found = await resolvePreviewTemplate(db, id, input);
  if (!found.ok) {
    throw found.missingStepId
      ? reachError.notFound('Step', found.missingStepId)
      : reachError.badRequest('The campaign has no step to preview');
  }
  const { template } = found;

  let prospect: ReachProspectRow | null;
  if (input.prospectId) {
    prospect = await findLiveProspect(db, input.prospectId);
    if (!prospect) throw reachError.notFound('Prospect', input.prospectId);
  } else {
    prospect = await firstEnrolledProspect(db, id);
  }

  const mailbox = await firstCampaignMailbox(db, id);

  const values = buildTemplateValues(prospect ?? SAMPLE_PROSPECT, mailbox ?? { firstName: 'Sam', lastName: 'Taylor' });
  const rendered = renderStepContent(template, values);
  const settings = await loadReachSettings(db);
  return {
    subject: rendered.subject,
    body: composeBody(rendered.body, mailbox?.signature) + buildEmailFooter(settings),
    missingVariables: rendered.missing,
  };
}

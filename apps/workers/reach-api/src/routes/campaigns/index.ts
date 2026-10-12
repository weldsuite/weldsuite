/**
 * Campaigns: /api/reach/campaigns
 *
 * Permissions: reach_campaigns:read | create | update | delete (launch, pause,
 * resume, steps, mailboxes and enrolling count as update). Every mutation
 * publishes a `reach_campaign` entity event (created / updated / deleted /
 * launched / paused / completed).
 *
 * Sending itself happens in the `reach-send` queue consumer; the routes only
 * change state and mark the workspace due (`markWorkspaceDue`) so the next
 * sweep picks it up.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, ilike, inArray, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import {
  addReachCampaignProspectsSchema,
  createReachCampaignSchema,
  previewReachStepSchema,
  reachCampaignStatusSchema,
  reachEnrollmentStatusSchema,
  replaceReachStepsSchema,
  resolveWeldReachLimits,
  setReachCampaignMailboxesSchema,
  updateReachCampaignSchema,
  type ReachRenderedPreview,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachProspects,
  type ReachCampaign,
} from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import {
  activateQueuedEnrollments,
  campaignDefaults,
  campaignStepStats,
  earliestDueAt,
  emptyStats,
  findCampaign,
  launchProblems,
  loadCampaignDetail,
  loadCampaignMailboxIds,
  loadReachSettings,
  loadSteps,
  recountCampaignProspects,
  scheduleProblem,
  toCampaign,
} from '../../services/campaigns';
import {
  addProspectsToCampaign,
  countCampaignEnrollments,
  listCampaignEnrollments,
  removeEnrollment,
  toEnrollment,
} from '../../services/enrollments';
import { findList } from '../../services/lists';
import { cursorCondition, likePattern, pageOf, parseLimit } from '../../services/list-query';
import { buildEmailFooter, buildTemplateValues, composeBody, renderStepContent } from '../../services/render';
import { completeAndPublish } from './events';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The entity-event coverage sweep reads this file, so the publish call is spelled out here. */
function emitCampaign(
  c: AppContext,
  action: 'created' | 'updated' | 'deleted' | 'launched' | 'paused' | 'completed',
  row: Pick<ReachCampaign, 'id'> & Partial<ReachCampaign>,
) {
  publishEntityEvent({ c, entityType: 'reach_campaign', action, entityId: row.id, data: row });
}

/** A 409 with its own code, so the UI can tell "pause it first" from a plain conflict. */
function stateConflict(c: AppContext, code: string, message: string) {
  return c.json({ error: { code, message } }, 409);
}

/** Tell the send sweep when this workspace next has outreach due. */
async function markDue(c: AppContext, at: Date | null): Promise<void> {
  const now = new Date();
  await markWorkspaceDue(c.env.SCHEDULE_INDEX, 'reach_send', c.get('workspaceId'), at && at.getTime() > now.getTime() ? at : now);
}

async function detailOrFail(c: AppContext, id: string) {
  const detail = await loadCampaignDetail(c.get('tenantDb'), id);
  return detail ? success(c, detail) : error.notFound(c, 'Campaign', id);
}

app.get('/', requirePermission('reach_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = parseLimit(q.limit);

  const conditions = [isNull(reachCampaigns.deletedAt)];
  if (q.status) {
    const parsed = reachCampaignStatusSchema.safeParse(q.status);
    if (!parsed.success) return error.badRequest(c, 'Unknown status filter');
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
  const page = pageOf(rows, limit);
  return list(c, page.data.map(toCampaign), cursorPagination(Number(total), page.hasMore, page.nextCursor));
});

app.get('/:id', requirePermission('reach_campaigns:read'), async (c) => detailOrFail(c, c.req.param('id')));

app.post('/', requirePermission('reach_campaigns:create'), zValidator('json', createReachCampaignSchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  const defaults = campaignDefaults(await loadReachSettings(db));
  const merged = { ...defaults, ...input };

  const problem = scheduleProblem({
    timezone: merged.timezone ?? 'Europe/Amsterdam',
    windowStart: merged.windowStart ?? '09:00',
    windowEnd: merged.windowEnd ?? '17:00',
  });
  if (problem) return error.badRequest(c, problem);

  const userId = c.get('userId');
  const [row] = await db
    .insert(reachCampaigns)
    .values({
      id: generateId('rcmp'),
      ...merged,
      status: 'draft',
      stats: emptyStats,
      ownerId: userId,
      createdBy: userId,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create the campaign');
  emitCampaign(c, 'created', row);
  return success(c, { ...toCampaign(row), steps: [], mailboxIds: [] }, 201);
});

app.patch('/:id', requirePermission('reach_campaigns:update'), zValidator('json', updateReachCampaignSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const current = await findCampaign(db, id);
  if (!current) return error.notFound(c, 'Campaign', id);

  const problem = scheduleProblem({
    timezone: input.timezone ?? current.timezone,
    windowStart: input.windowStart ?? current.windowStart,
    windowEnd: input.windowEnd ?? current.windowEnd,
  });
  if (problem) return error.badRequest(c, problem);

  const [row] = await db
    .update(reachCampaigns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(reachCampaigns.id, id), isNull(reachCampaigns.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Campaign', id);
  emitCampaign(c, 'updated', row);
  return detailOrFail(c, id);
});

app.delete('/:id', requirePermission('reach_campaigns:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const current = await findCampaign(db, id);
  if (!current) return error.notFound(c, 'Campaign', id);
  if (current.status === 'active') return stateConflict(c, 'CAMPAIGN_ACTIVE', 'Pause the campaign before deleting it');

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
  emitCampaign(c, 'deleted', { id });
  return noContent(c);
});

app.put('/:id/steps', requirePermission('reach_campaigns:update'), zValidator('json', replaceReachStepsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { steps } = c.req.valid('json');
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);
  if (campaign.status === 'active') return stateConflict(c, 'CAMPAIGN_ACTIVE', 'Pause the campaign before changing its steps');

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
  emitCampaign(c, 'updated', campaign);
  return detailOrFail(c, id);
});

app.put('/:id/mailboxes', requirePermission('reach_campaigns:update'), zValidator('json', setReachCampaignMailboxesSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const mailboxIds = [...new Set(c.req.valid('json').mailboxIds)];
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);

  if (mailboxIds.length > 0) {
    const found = await db
      .select({ id: reachMailboxes.id })
      .from(reachMailboxes)
      .where(and(inArray(reachMailboxes.id, mailboxIds), isNull(reachMailboxes.deletedAt), ne(reachMailboxes.status, 'deleted')));
    const known = new Set(found.map((m) => m.id));
    const unknown = mailboxIds.filter((m) => !known.has(m));
    if (unknown.length > 0) return error.badRequest(c, 'Some mailboxes do not exist', { unknown });
  }

  await atomically(db, (h) => [
    h.delete(reachCampaignMailboxes).where(eq(reachCampaignMailboxes.campaignId, id)),
    ...(mailboxIds.length > 0
      ? [h.insert(reachCampaignMailboxes).values(mailboxIds.map((mailboxId) => ({ id: generateId('rcmb'), campaignId: id, mailboxId })))]
      : []),
  ]);
  emitCampaign(c, 'updated', campaign);
  return detailOrFail(c, id);
});

app.post('/:id/prospects', requirePermission('reach_campaigns:update'), zValidator('json', addReachCampaignProspectsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);
  if (campaign.status === 'completed' || campaign.status === 'archived') {
    return stateConflict(c, 'CAMPAIGN_CLOSED', 'This campaign has finished; add the prospects to a new campaign');
  }
  if (input.listId && !(await findList(db, input.listId))) return error.notFound(c, 'List', input.listId);

  const limits = resolveWeldReachLimits(c.get('appAccess')?.limits);
  const { report } = await addProspectsToCampaign(db, id, input, { allowConsumer: limits.allowConsumerRecipients });
  await recountCampaignProspects(db, id);

  if (campaign.status === 'active' && report.added > 0) {
    const { earliest } = await activateQueuedEnrollments(db, campaign);
    await markDue(c, earliest);
  }
  emitCampaign(c, 'updated', campaign);
  return success(c, report);
});

app.get('/:id/enrollments', requirePermission('reach_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const q = c.req.query();
  if (!(await findCampaign(db, id))) return error.notFound(c, 'Campaign', id);
  const limit = parseLimit(q.limit);

  let status;
  if (q.status) {
    const parsed = reachEnrollmentStatusSchema.safeParse(q.status);
    if (!parsed.success) return error.badRequest(c, 'Unknown status filter');
    status = parsed.data;
  }
  const after = await cursorCondition(db, reachEnrollments, q.cursor);
  const [rows, total] = await Promise.all([
    listCampaignEnrollments(db, id, { status, cursorCondition: after, limit }),
    countCampaignEnrollments(db, id, status),
  ]);
  const page = pageOf(
    rows.map((r) => ({ ...r, id: r.row.id })),
    limit,
  );
  return list(
    c,
    page.data.map((r) => toEnrollment(r.row, r.prospect, r.mailboxEmail)),
    cursorPagination(total, page.hasMore, page.nextCursor),
  );
});

app.delete('/:id/enrollments/:enrollmentId', requirePermission('reach_campaigns:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);
  const removed = await removeEnrollment(db, id, c.req.param('enrollmentId'));
  if (!removed) return error.notFound(c, 'Enrollment', c.req.param('enrollmentId'));
  await recountCampaignProspects(db, id);
  emitCampaign(c, 'updated', campaign);
  await completeAndPublish(c, db, [id]);
  return noContent(c);
});

app.post('/:id/launch', requirePermission('reach_campaigns:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);
  if (campaign.status === 'active') return stateConflict(c, 'CAMPAIGN_ACTIVE', 'This campaign is already running');
  if (campaign.status === 'paused') return stateConflict(c, 'CAMPAIGN_PAUSED', 'This campaign is paused; resume it instead');
  if (campaign.status === 'archived') return stateConflict(c, 'CAMPAIGN_CLOSED', 'This campaign is archived');

  const problems = await launchProblems(db, id);
  if (problems.length > 0) return error.badRequest(c, 'This campaign cannot be launched yet', { problems });

  // Active enrollments do nothing while the campaign is not active, so they can go first.
  const now = new Date();
  const { earliest } = await activateQueuedEnrollments(db, campaign, now);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'active', launchedAt: campaign.launchedAt ?? now, completedAt: null, pausedReason: null, updatedAt: now })
    .where(and(eq(reachCampaigns.id, id), inArray(reachCampaigns.status, ['draft', 'completed'])))
    .returning();
  if (!row) return stateConflict(c, 'CAMPAIGN_ACTIVE', 'This campaign was changed by someone else');

  await markDue(c, earliest);
  emitCampaign(c, 'launched', row);
  return detailOrFail(c, id);
});

app.post('/:id/pause', requirePermission('reach_campaigns:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await findCampaign(db, id))) return error.notFound(c, 'Campaign', id);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'paused', pausedReason: 'manual', updatedAt: new Date() })
    .where(and(eq(reachCampaigns.id, id), eq(reachCampaigns.status, 'active')))
    .returning();
  if (!row) return stateConflict(c, 'CAMPAIGN_NOT_ACTIVE', 'Only a running campaign can be paused');
  emitCampaign(c, 'paused', row);
  return detailOrFail(c, id);
});

app.post('/:id/resume', requirePermission('reach_campaigns:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const campaign = await findCampaign(db, id);
  if (!campaign) return error.notFound(c, 'Campaign', id);
  if (campaign.status !== 'paused') return stateConflict(c, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign can be resumed');

  const now = new Date();
  // Prospects added while it was paused wait as queued until now.
  const { earliest } = await activateQueuedEnrollments(db, campaign, now);
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'active', pausedReason: null, updatedAt: now })
    .where(and(eq(reachCampaigns.id, id), eq(reachCampaigns.status, 'paused')))
    .returning();
  if (!row) return stateConflict(c, 'CAMPAIGN_NOT_PAUSED', 'This campaign was changed by someone else');

  await markDue(c, (await earliestDueAt(db, id)) ?? earliest);
  emitCampaign(c, 'updated', row);
  return detailOrFail(c, id);
});

app.post('/:id/preview', requirePermission('reach_campaigns:read'), zValidator('json', previewReachStepSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  if (!(await findCampaign(db, id))) return error.notFound(c, 'Campaign', id);

  let template: { subject: string; body: string } | null = null;
  if (input.subject !== undefined || input.body !== undefined) {
    template = { subject: input.subject ?? '', body: input.body ?? '' };
  } else {
    const steps = await loadSteps(db, id);
    const step = input.stepId ? steps.find((s) => s.id === input.stepId) : steps[0];
    if (input.stepId && !step) return error.notFound(c, 'Step', input.stepId);
    if (step) template = { subject: step.subject, body: step.body };
  }
  if (!template) return error.badRequest(c, 'The campaign has no step to preview');

  let prospect = null;
  if (input.prospectId) {
    [prospect] = await db
      .select()
      .from(reachProspects)
      .where(and(eq(reachProspects.id, input.prospectId), isNull(reachProspects.deletedAt)))
      .limit(1);
    if (!prospect) return error.notFound(c, 'Prospect', input.prospectId);
  } else {
    const [first] = await db
      .select({ prospect: reachProspects })
      .from(reachEnrollments)
      .innerJoin(reachProspects, eq(reachProspects.id, reachEnrollments.prospectId))
      .where(and(eq(reachEnrollments.campaignId, id), isNull(reachProspects.deletedAt)))
      .orderBy(asc(reachEnrollments.createdAt))
      .limit(1);
    prospect = first?.prospect ?? null;
  }

  const mailboxIds = await loadCampaignMailboxIds(db, id);
  const [mailbox] =
    mailboxIds.length > 0
      ? await db
          .select({ firstName: reachMailboxes.firstName, lastName: reachMailboxes.lastName, signature: reachMailboxes.signature })
          .from(reachMailboxes)
          .where(and(inArray(reachMailboxes.id, mailboxIds), isNull(reachMailboxes.deletedAt)))
          .orderBy(asc(reachMailboxes.createdAt))
          .limit(1)
      : [];

  const sampleProspect = {
    email: 'alex.morgan@example.com',
    firstName: 'Alex',
    lastName: 'Morgan',
    companyName: 'Example Inc',
    title: 'Operations Manager',
    customFields: {},
  };
  const values = buildTemplateValues(prospect ?? sampleProspect, mailbox ?? { firstName: 'Sam', lastName: 'Taylor' });
  const rendered = renderStepContent(template, values);
  const settings = await loadReachSettings(db);
  const preview: ReachRenderedPreview = {
    subject: rendered.subject,
    body: composeBody(rendered.body, mailbox?.signature) + buildEmailFooter(settings),
    missingVariables: rendered.missing,
  };
  return success(c, preview);
});

app.get('/:id/stats', requirePermission('reach_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await findCampaign(db, id))) return error.notFound(c, 'Campaign', id);
  return success(c, await campaignStepStats(db, id));
});

export default app;

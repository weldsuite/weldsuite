/**
 * /api/approvals: My reviews, "Sent by me", "Done", answering a review and
 * delegation (design: weldflow-delivery-and-portfolio.md, "Answer a review";
 * ADR FLOW-016).
 *
 *   GET    /mine                              open reviews in groups (overdue, this week, later), type filter
 *   GET    /mine/count                        the sidebar badge
 *   GET    /sent                              subjects the caller asked approval for that still wait
 *   GET    /done                              reviews the caller answered
 *   POST   /:id/decide                        approve, approve with conditions, decline, ask for information
 *   GET    /delegations                       delegations that have not ended, given and received
 *   POST   /delegations                       hand the caller's reviews to a member for a period
 *   DELETE /delegations/:id                   end a delegation of the caller's
 *   PUT    /projects/:projectId/sponsor       set or clear the project sponsor (settings.sponsorId)
 *
 * Answering is a right of the row (the named approver or their active
 * delegate, `decideApproval`), never of a workspace permission: every route
 * needs `projects:read` only, and a pending time entry in the inbox also needs
 * `time:update` and `canManageProject`, as `PATCH /api/time-entries/:id/approve`
 * does. The sponsor route is a settings write: `projects:update` and
 * `canManageProject`.
 *
 * Importing the services below registers every approval subject of the slice
 * (change requests and accepting a risk), so any isolate that settles an answer
 * can apply it.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  createDelegationSchema,
  decideApprovalSchema,
  listMyReviewsQuerySchema,
  listReviewsQuerySchema,
  setSponsorSchema,
} from '@weldsuite/app-api-client/schemas/flow-approvals';
import {
  decisionInputError,
} from '@weldsuite/flow-domain/approvals';
import {
  SPONSOR_MESSAGES,
  TIMESHEET_MESSAGES,
  delegationEventData,
  delegationInputError,
  presentDelegation,
  presentReviewApprover,
} from '@weldsuite/flow-domain/approval-views';
import type { Env, Variables } from '../../types';
import { canManageProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import {
  countMyReviews,
  loadDoneReviews,
  loadMyReviews,
  loadSentReviews,
  decideAndAnnounce,
} from '../../services/approvals';
import { findLiveProject, projectMemberIds } from '../../services/project-changes';
import { applyTimeEntryReview, reviewDenial } from '../../services/time-entry-review';
// Every approval subject registers its handler and aftermath on import.
import '../../services/risk-acceptance';
import '../../services/governance-approvals';
import '../../services/project-phases';
import '../../services/project-closing';
import '../../services/project-requests';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.flowApprovals;
const delegations = schema.flowApprovalDelegations;

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseBody<S extends z.ZodTypeAny>(c: AppContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid request body', details) };
  }
  return { ok: true, data: parsed.data };
}

/** The query string without empty values (`?projectId=` means no filter). */
function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

const PROJECT_EDIT_DENIED = 'You must be a project owner, admin, or manager to edit this project';

// ── My reviews ──────────────────────────────────────────────────────────────

app.get('/mine', requirePermission('projects:read'), async (c) => {
  const query = readQuery(c, listMyReviewsQuerySchema);
  if (!query.ok) return query.response;
  try {
    const [scopeAll, canReviewTime] = await Promise.all([hasContextPermission(c, 'projects:scope:all'), hasContextPermission(c, 'time:update')]);
    const reviews = await loadMyReviews(c.get('tenantDb'), {
      userId: c.get('userId'),
      scopeAll,
      canReviewTime,
      type: query.data.type,
      projectId: query.data.projectId,
      now: new Date(),
    });
    return success(c, reviews);
  } catch (err) {
    console.error('[flow-api/approvals] mine failed:', err);
    return error.internal(c, 'Failed to load your reviews');
  }
});

// MUST be a separate path from /mine: the badge polls it.
app.get('/mine/count', requirePermission('projects:read'), async (c) => {
  try {
    const [scopeAll, canReviewTime] = await Promise.all([hasContextPermission(c, 'projects:scope:all'), hasContextPermission(c, 'time:update')]);
    return success(c, await countMyReviews(c.get('tenantDb'), { userId: c.get('userId'), scopeAll, canReviewTime, now: new Date() }));
  } catch (err) {
    console.error('[flow-api/approvals] count failed:', err);
    return error.internal(c, 'Failed to count your reviews');
  }
});

app.get('/sent', requirePermission('projects:read'), async (c) => {
  const query = readQuery(c, listReviewsQuerySchema);
  if (!query.ok) return query.response;
  const limit = parseLimit(query.data.limit, 25, 100);
  try {
    const page = await loadSentReviews(c.get('tenantDb'), c.get('userId'), { ...query.data, limit }, new Date());
    return list(c, page.items, cursorPagination(page.total, page.hasMore, page.nextCursor));
  } catch (err) {
    console.error('[flow-api/approvals] sent failed:', err);
    return error.internal(c, 'Failed to load the reviews you sent');
  }
});

app.get('/done', requirePermission('projects:read'), async (c) => {
  const query = readQuery(c, listReviewsQuerySchema);
  if (!query.ok) return query.response;
  const limit = parseLimit(query.data.limit, 25, 100);
  try {
    const page = await loadDoneReviews(c.get('tenantDb'), c.get('userId'), { ...query.data, limit }, new Date());
    return list(c, page.items, cursorPagination(page.total, page.hasMore, page.nextCursor));
  } catch (err) {
    console.error('[flow-api/approvals] done failed:', err);
    return error.internal(c, 'Failed to load the reviews you answered');
  }
});

// ── Delegations ─────────────────────────────────────────────────────────────
// Static paths, before /:id.

app.get('/delegations', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const now = new Date();
    const [given, received] = await Promise.all([
      db
        .select()
        .from(delegations)
        .where(and(eq(delegations.memberId, userId), isNull(delegations.deletedAt), gt(delegations.endsAt, now)))
        .orderBy(delegations.startsAt, delegations.id),
      db
        .select()
        .from(delegations)
        .where(and(eq(delegations.delegateId, userId), isNull(delegations.deletedAt), gt(delegations.endsAt, now)))
        .orderBy(delegations.startsAt, delegations.id),
    ]);
    return success(c, { given: given.map(presentDelegation), received: received.map(presentDelegation) });
  } catch (err) {
    console.error('[flow-api/approvals] delegations failed:', err);
    return error.internal(c, 'Failed to load delegations');
  }
});

app.post('/delegations', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createDelegationSchema);
  if (!body.ok) return body.response;
  const now = new Date();
  const startsAt = new Date(body.data.startsAt);
  const endsAt = new Date(body.data.endsAt);
  const refusal = delegationInputError({ memberId: userId, delegateId: body.data.delegateId, startsAt, endsAt }, now);
  if (refusal) return error.badRequest(c, refusal);
  try {
    const [row] = await db
      .insert(delegations)
      .values({
        id: generateId('apd'),
        memberId: userId,
        delegateId: body.data.delegateId,
        startsAt,
        endsAt,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) return error.internal(c, 'Failed to create the delegation');
    publishEntityEvent({ c, entityType: 'flow_approval', entityId: row.id, action: 'delegated', data: delegationEventData(row, false) });
    return success(c, presentDelegation(row), 201);
  } catch (err) {
    console.error('[flow-api/approvals] delegate failed:', err);
    return error.internal(c, 'Failed to create the delegation');
  }
});

app.delete('/delegations/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(delegations)
      .where(and(eq(delegations.id, id), eq(delegations.memberId, userId), isNull(delegations.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Delegation', id);
    const now = new Date();
    await db.update(delegations).set({ deletedAt: now, updatedAt: now }).where(and(eq(delegations.id, id), isNull(delegations.deletedAt)));
    publishEntityEvent({ c, entityType: 'flow_approval', entityId: id, action: 'delegated', data: delegationEventData(row, true) });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/approvals] end delegation failed:', err);
    return error.internal(c, 'Failed to end the delegation');
  }
});

// ── Sponsor (settings.sponsorId) ────────────────────────────────────────────

app.put('/projects/:projectId/sponsor', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_EDIT_DENIED);
  const body = await parseBody(c, setSponsorSchema);
  if (!body.ok) return body.response;
  const { sponsorId } = body.data;
  try {
    if (sponsorId !== null && !(await projectMemberIds(db, projectId, project.projectManagerId)).has(sponsorId)) {
      return error.badRequest(c, SPONSOR_MESSAGES.notMember);
    }
    // A merge write of this key only: other features keep theirs.
    await db
      .update(schema.projects)
      .set({
        settings: sql`coalesce(${schema.projects.settings}, '{}'::jsonb) || jsonb_build_object('sponsorId', ${sponsorId}::text)`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (row) {
      publishEntityEvent({
        c,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        data: projectAnalyticsPayload(row as Record<string, unknown>),
      });
    }
    return success(c, { projectId, sponsorId });
  } catch (err) {
    console.error('[flow-api/approvals] set sponsor failed:', err);
    return error.internal(c, 'Failed to set the sponsor');
  }
});

// ── Answer a review ─────────────────────────────────────────────────────────

app.post('/:id/decide', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await parseBody(c, decideApprovalSchema);
  if (!body.ok) return body.response;
  const { decision, note } = body.data;

  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return await decideTimeEntry(c, id, decision, note ?? null);

    const result = await decideAndAnnounce(c, row, { actor: userId, decision, note });
    if (!result.ok) {
      switch (result.code) {
        case 'not_found':
          return error.notFound(c, 'Approval', id);
        case 'not_approver':
          return error.forbidden(c, result.message);
        case 'already_decided':
        case 'step_not_active':
          return error.conflict(c, result.message);
        default:
          return error.badRequest(c, result.message);
      }
    }

    return success(c, {
      approval: { ...presentReviewApprover(result.approval), subjectType: row.subjectType, subjectId: row.subjectId, projectId: row.projectId },
      outcome: result.outcome,
      resolved: result.resolved,
      viaDelegation: result.viaDelegation,
    });
  } catch (err) {
    console.error('[flow-api/approvals] decide failed:', err);
    return error.internal(c, 'Failed to answer the review');
  }
});

/**
 * A pending time entry answered from My reviews: approve or decline, with the
 * rules and the events of `PATCH /api/time-entries/:id/approve` and `/reject`
 * (FLOW-006, FLOW-016). The inbox row's id is the time entry's.
 */
async function decideTimeEntry(c: AppContext, id: string, decision: string, note: string | null): Promise<Response> {
  const db = c.get('tenantDb');
  const [entry] = await db
    .select()
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.id, id), isNull(schema.timeEntries.deletedAt)))
    .limit(1);
  if (!entry) return error.notFound(c, 'Approval', id);
  if (!(await hasContextPermission(c, 'time:update'))) return error.forbidden(c, TIMESHEET_MESSAGES.noPermission);
  const denial = await reviewDenial(c, entry);
  if (denial) return error.forbidden(c, denial);
  if (decision !== 'approved' && decision !== 'rejected') return error.badRequest(c, TIMESHEET_MESSAGES.onlyApproveOrDecline);
  const invalid = decisionInputError({ decision, note });
  if (invalid) return error.badRequest(c, invalid);
  if (entry.status === 'approved' || entry.status === 'rejected') return error.conflict(c, 'This review has already been answered');

  await applyTimeEntryReview(c, entry, decision);
  const now = new Date();
  return success(c, {
    approval: {
      approvalId: entry.id,
      approverKind: 'member' as const,
      approverId: c.get('userId'),
      roleLabel: null,
      step: 1,
      decision,
      note: note?.trim() ? note.trim() : null,
      decidedAt: now.toISOString(),
      delegatedFrom: null,
      subjectType: 'timesheet',
      subjectId: entry.id,
      projectId: entry.projectId,
    },
    outcome: decision,
    resolved: true,
    viaDelegation: false,
  });
}


export const approvalsRoutes = app;

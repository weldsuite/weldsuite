/**
 * Change request routes: /api/project-changes/*, backed by
 * `project_change_requests` (design: weldflow-project-control.md, "Change
 * request"; ADRs FLOW-012 and FLOW-013). The approvers' answers are
 * `flow_approvals` rows (subject `change_request`), answered in My reviews
 * (`POST /api/approvals/:id/decide`); approving runs `applyApprovedChange`.
 *
 *   GET    /                          list (projectId optional, filters, cursor)
 *   GET    /settings/:projectId       the approval rules, the sponsor and the warnings
 *   PUT    /settings/:projectId       set the rules (merge write of settings.changeControl)
 *   GET    /:id                       change with approvers, effects, routing and baseline version
 *   POST   /                          create a draft
 *   PATCH  /:id                       edit; editing the impact after submission sends it back to assessing
 *   DELETE /:id                       delete a draft or a withdrawn change
 *   POST   /:id/submit                route it by its impact and ask the approvers
 *   POST   /:id/withdraw              withdraw an open change and clear its approvals
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001). The checks run in a fixed
 * order so every backend answers alike: permission, then the change (404),
 * then project access (403), then the body (400), then the business rules.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  changeControlSettingsSchema,
  createChangeRequestSchema,
  listChangeRequestsQuerySchema,
  updateChangeRequestSchema,
} from '@weldsuite/app-api-client/schemas/flow-approvals';
import {
  CHANGE_APPROVAL_DUE_DAYS,
  CHANGE_MESSAGES,
  boardOutsiders,
  changeApproverRows,
  changeCode,
  changeEventData,
  changeImpactError,
  changeSequence,
  computeEffects,
  effectiveChangeControl,
  findChangeRequest,
  impactChanged,
  isOpenChange,
  presentChangeRequest,
  presentRouting,
  routeChange,
  type ChangeRequestRow,
  type ChangeRouting,
} from '@weldsuite/flow-domain/changes';
import { loadPlanState } from '@weldsuite/flow-domain/baselines';
import {
  cancelPendingApprovals,
  listPendingForApprover,
  listSubjectApprovals,
  requestApprovals,
} from '@weldsuite/flow-domain/approvals';
import { presentReviewApprover } from '@weldsuite/flow-domain/approval-views';
import { allocateNumber } from '@weldsuite/flow-domain/task-numbering';
import type { Env, Variables } from '../../types';
import {
  accessibleProjectIds,
  canAccessProject,
  canManageProject,
  canWriteProject,
  inAccessibleProjects,
} from '../../lib/project-access';
import { containsPattern, parseLimit } from '../../lib/query-params';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { announceApprovalsCancelled, announceApprovalsRequested } from '../../services/approvals';
import { findLiveProject, knownPlanIds, projectMemberIds } from '../../services/project-changes';
import { money } from '../../services/project-raid';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectChangeRequests;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
const PROJECT_EDIT_DENIED = 'You must be a project owner, admin, or manager to edit this project';
const ITEM_LABEL = 'Change request';
const DAY_MS = 86_400_000;


type ChangeAction = 'created' | 'updated' | 'submitted';

/** One `project_change_request` entity event for the change as it now stands. */
function publishChange(c: AppContext, action: ChangeAction, row: ChangeRequestRow): void {
  publishEntityEvent({ c, entityType: 'project_change_request', entityId: row.id, action, data: changeEventData(row) });
}
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

function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

// ── Settings: the approval rules (FLOW-013) ─────────────────────────────────

type LiveProject = NonNullable<Awaited<ReturnType<typeof findLiveProject>>>;

function settingsResponse(project: LiveProject) {
  const control = effectiveChangeControl(project.settings);
  return {
    projectId: project.id,
    changeControl: control,
    configured: !!project.settings?.changeControl,
    sponsorId: project.settings?.sponsorId || null,
    projectManagerId: project.projectManagerId,
    currency: project.budgetCurrency,
    warnings: control.boardMemberIds.length === 0 ? ['no_board' as const] : [],
  };
}

app.get('/settings/:projectId', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findLiveProject(c.get('tenantDb'), projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, settingsResponse(project));
  } catch (err) {
    console.error('[flow-api/project-changes] settings failed:', err);
    return error.internal(c, 'Failed to load the change control settings');
  }
});

app.put('/settings/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_EDIT_DENIED);
  const body = await parseBody(c, changeControlSettingsSchema);
  if (!body.ok) return body.response;
  const control = { ...body.data, boardMemberIds: [...new Set(body.data.boardMemberIds)] };
  try {
    const outsiders = boardOutsiders(control.boardMemberIds, await projectMemberIds(db, projectId, project.projectManagerId));
    if (outsiders.length > 0) return error.badRequest(c, CHANGE_MESSAGES.boardNotMembers);
    // A merge write of this key only: other features keep theirs.
    await db
      .update(schema.projects)
      .set({
        settings: sql`coalesce(${schema.projects.settings}, '{}'::jsonb) || jsonb_build_object('changeControl', ${JSON.stringify(control)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
    const updated = await findLiveProject(db, projectId);
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (row) {
      publishEntityEvent({ c, entityType: 'project', entityId: projectId, action: 'updated', data: projectAnalyticsPayload(row as Record<string, unknown>) });
    }
    return success(c, settingsResponse(updated ?? project));
  } catch (err) {
    console.error('[flow-api/project-changes] set settings failed:', err);
    return error.internal(c, 'Failed to save the change control settings');
  }
});

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listChangeRequestsQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 25, 100);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
    conditions.push(eq(t.projectId, q.projectId));
  } else {
    conditions.push(inAccessibleProjects(t.projectId, await accessibleProjectIds(c)));
  }
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.search) {
    const pattern = containsPattern(q.search);
    conditions.push(or(ilike(t.title, pattern), ilike(t.description, pattern)) as SQL);
  }
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
    }
  }
  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data.map(presentChangeRequest), cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[flow-api/project-changes] list failed:', err);
    return error.internal(c, 'Failed to list change requests');
  }
});

/** What the project's current rules say about a change's impact, or what the change was routed by. */
function routingOf(row: ChangeRequestRow, project: LiveProject, approvalRules: Array<Record<string, unknown> | undefined>): ChangeRouting {
  const current = routeChange({
    costDelta: row.costDelta,
    scheduleDeltaDays: row.scheduleDeltaDays,
    settings: project.settings,
    projectManagerId: project.projectManagerId,
  });
  const stored = approvalRules.find((params) => params !== undefined);
  if (!row.route || !stored) return current;
  // Routed already: the rules it was routed by, as the approvals recorded them.
  const num = (key: string, fallback: number) => (typeof stored[key] === 'number' ? (stored[key] as number) : fallback);
  return {
    ...current,
    route: row.route,
    overLimit: stored.overLimit === true,
    noBoard: stored.noBoard === true,
    costLimit: num('costLimit', current.costLimit),
    scheduleLimitDays: num('scheduleLimitDays', current.scheduleLimitDays),
  };
}

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findChangeRequest(db, id);
    if (!row) return error.notFound(c, ITEM_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    const project = await findLiveProject(db, row.projectId);
    if (!project) return error.notFound(c, ITEM_LABEL, id);

    const [rows, plan, pending, baseline] = await Promise.all([
      listSubjectApprovals(db, 'change_request', id),
      loadPlanState(db, row.projectId),
      listPendingForApprover(db, c.get('userId'), { subjectTypes: ['change_request'] }),
      row.baselineId
        ? db.select({ version: schema.projectBaselines.version }).from(schema.projectBaselines).where(eq(schema.projectBaselines.id, row.baselineId)).limit(1)
        : Promise.resolve([]),
    ]);
    const applied = row.status === 'approved' || row.status === 'implemented';
    const effects = computeEffects(row, plan ?? { goLive: null, milestones: [], deliverables: [], budgetedAmount: null, budgetedHours: null, budgetCurrency: null, scopeStatement: null }, applied);
    return success(c, {
      ...presentChangeRequest(row),
      approvers: rows.map(presentReviewApprover),
      effects,
      routing: presentRouting(
        routingOf(
          row,
          project,
          rows.map((r) => r.rule.params),
        ),
      ),
      baselineVersion: baseline[0]?.version ?? null,
      canDecide: pending.some((review) => review.approval.subjectId === id),
    });
  } catch (err) {
    console.error('[flow-api/project-changes] get failed:', err);
    return error.internal(c, 'Failed to fetch change request');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createChangeRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await findLiveProject(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const impactError = changeImpactError(input, await knownPlanIds(db, input.projectId));
  if (impactError) return error.badRequest(c, impactError);

  try {
    const now = new Date();
    const id = generateId('pcr');
    const number = await allocateNumber(db, changeSequence(input.projectId));
    const [row] = await db
      .insert(t)
      .values({
        id,
        projectId: input.projectId,
        number,
        title: input.title,
        description: input.description ?? null,
        requestedBy: userId,
        status: 'draft',
        costDelta: money(input.costDelta),
        scheduleDeltaDays: input.scheduleDeltaDays ?? null,
        planChanges: input.planChanges ?? null,
        scopeChanges: input.scopeChanges ?? null,
        clientVisible: input.clientVisible ?? false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) return error.internal(c, 'Failed to create change request');
    publishChange(c, 'created', row);
    return success(c, presentChangeRequest(row), 201);
  } catch (err) {
    console.error('[flow-api/project-changes] create failed:', err);
    return error.internal(c, 'Failed to create change request');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

/** The columns an edit sets: only the fields it sent. */
function changeUpdateSet(data: z.infer<typeof updateChangeRequestSchema>, now: Date): Partial<typeof t.$inferInsert> {
  const set: Partial<typeof t.$inferInsert> = { updatedAt: now };
  if (data.title !== undefined) set.title = data.title;
  if (data.description !== undefined) set.description = data.description;
  if (data.costDelta !== undefined) set.costDelta = money(data.costDelta);
  if (data.scheduleDeltaDays !== undefined) set.scheduleDeltaDays = data.scheduleDeltaDays;
  if (data.planChanges !== undefined) set.planChanges = data.planChanges;
  if (data.scopeChanges !== undefined) set.scopeChanges = data.scopeChanges;
  if (data.clientVisible !== undefined) set.clientVisible = data.clientVisible;
  return set;
}

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findChangeRequest(db, id);
  if (!existing) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateChangeRequestSchema);
  if (!body.ok) return body.response;
  const data = body.data;
  if (!isOpenChange(existing.status)) return error.conflict(c, CHANGE_MESSAGES.notEditable);

  try {
    const next = {
      planChanges: data.planChanges !== undefined ? data.planChanges : existing.planChanges,
      scopeChanges: data.scopeChanges !== undefined ? data.scopeChanges : existing.scopeChanges,
    };
    if (data.planChanges !== undefined || data.scopeChanges !== undefined) {
      const impactError = changeImpactError(next, await knownPlanIds(db, existing.projectId));
      if (impactError) return error.badRequest(c, impactError);
    }

    const now = new Date();
    const set = changeUpdateSet(data, now);

    // Editing what the approvers weigh, once it is with them, starts the approval over (FLOW-013).
    const reroute = existing.status === 'awaiting_approval' && impactChanged(existing, data);
    if (reroute) {
      set.status = 'assessing';
      set.route = null;
      set.submittedAt = null;
    }
    const [row] = await db
      .update(t)
      .set(set)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();
    if (!row) return error.notFound(c, ITEM_LABEL, id);
    publishChange(c, 'updated', row);
    if (reroute) announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: id, includeDecided: true, now }));
    return success(c, presentChangeRequest(row));
  } catch (err) {
    console.error('[flow-api/project-changes] update failed:', err);
    return error.internal(c, 'Failed to update change request');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findChangeRequest(db, id);
    if (!existing) return error.notFound(c, ITEM_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    if (existing.status !== 'draft' && existing.status !== 'withdrawn') return error.conflict(c, CHANGE_MESSAGES.notDeletable);

    const now = new Date();
    await db.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_change_request',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, number: existing.number, code: changeCode(existing.number) },
    });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-changes] delete failed:', err);
    return error.internal(c, 'Failed to delete change request');
  }
});

// ── Submit ──────────────────────────────────────────────────────────────────

app.post('/:id/submit', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findChangeRequest(db, id);
  if (!existing) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (existing.status !== 'draft' && existing.status !== 'assessing') return error.conflict(c, CHANGE_MESSAGES.notSubmittable);

  try {
    const project = await findLiveProject(db, existing.projectId);
    if (!project) return error.notFound(c, 'Project', existing.projectId);
    const impactError = changeImpactError(existing, await knownPlanIds(db, existing.projectId));
    if (impactError) return error.badRequest(c, impactError);

    const routing = routeChange({
      costDelta: existing.costDelta,
      scheduleDeltaDays: existing.scheduleDeltaDays,
      settings: project.settings,
      projectManagerId: project.projectManagerId,
    });
    if (routing.route === 'board') {
      const outsiders = boardOutsiders(routing.approverIds, await projectMemberIds(db, existing.projectId, project.projectManagerId));
      if (outsiders.length > 0) return error.badRequest(c, CHANGE_MESSAGES.boardNotMembers);
    }
    if (routing.approverIds.length === 0) return error.badRequest(c, CHANGE_MESSAGES.noManager);

    const now = new Date();
    const due = new Date(now.getTime() + CHANGE_APPROVAL_DUE_DAYS * DAY_MS);
    const requested = await requestApprovals(db, {
      projectId: existing.projectId,
      subjectType: 'change_request',
      subjectId: id,
      requestedBy: userId,
      rows: changeApproverRows(routing, due),
      now,
    });
    if (!requested.ok) return error.badRequest(c, requested.message);

    const [row] = await db
      .update(t)
      .set({ status: 'awaiting_approval', route: routing.route, submittedAt: now, decidedAt: null, updatedAt: now })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();
    if (!row) {
      await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: id, includeDecided: true, now });
      return error.notFound(c, ITEM_LABEL, id);
    }
    publishChange(c, 'submitted', row);
    announceApprovalsRequested(c, {
      rows: requested.rows,
      subject: { code: changeCode(row.number), title: row.title },
      projectName: project.name,
    });
    return success(c, { change: presentChangeRequest(row), approvers: requested.rows.map(presentReviewApprover), routing: presentRouting(routing) });
  } catch (err) {
    console.error('[flow-api/project-changes] submit failed:', err);
    return error.internal(c, 'Failed to submit change request');
  }
});

// ── Withdraw ────────────────────────────────────────────────────────────────

app.post('/:id/withdraw', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findChangeRequest(db, id);
  if (!existing) return error.notFound(c, ITEM_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (existing.requestedBy !== userId && !(await canManageProject(c, existing.projectId))) {
    return error.forbidden(c, CHANGE_MESSAGES.withdrawDenied);
  }
  if (!isOpenChange(existing.status)) return error.conflict(c, CHANGE_MESSAGES.notWithdrawable);

  try {
    const now = new Date();
    const [row] = await db
      .update(t)
      .set({ status: 'withdrawn', updatedAt: now })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();
    if (!row) return error.notFound(c, ITEM_LABEL, id);
    publishChange(c, 'updated', row);
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: id, includeDecided: true, now }));
    return success(c, presentChangeRequest(row));
  } catch (err) {
    console.error('[flow-api/project-changes] withdraw failed:', err);
    return error.internal(c, 'Failed to withdraw change request');
  }
});


export const projectChangesRoutes = app;

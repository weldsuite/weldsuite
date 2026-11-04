/**
 * Decision log routes: /api/project-decisions/*, backed by `project_decisions`
 * (design: weldflow-project-control.md; ADRs FLOW-011 and FLOW-016).
 *
 *   GET    /                 list (projectId optional, filters, cursor)
 *   GET    /:id              decision, links, approvals, what replaced it and what it replaced
 *   POST   /                 create: proposed (with an optional named decider), or recorded as decided
 *   PATCH  /:id              edit (while decided, only title, context and consequences)
 *   DELETE /:id              soft delete, with the decision's links and open approvals
 *   POST   /:id/decide       record the decision: the project manager or the named decider
 *   POST   /:id/supersede    a newer decision replaces this one
 *
 * A proposed decision with a named decider asks them through `flow_approvals`
 * (subject `decision`, rule `decision`, due `decision_due_at`). Approving makes
 * the decision decided; declining leaves it proposed with the note on the
 * approval, and editing it asks again.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001). The checks run in a fixed
 * order so every backend answers alike: permission, then the decision (404),
 * then project access (403), then the body (400), then the business rules.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  DECISION_STATUSES,
  createDecisionSchema,
  decideDecisionSchema,
  supersedeDecisionSchema,
  updateDecisionSchema,
} from '@weldsuite/app-api-client/schemas/project-governance';
import {
  cancelPendingApprovals,
  listSubjectApprovals,
  requestApprovals,
  type ApprovalRow,
} from '@weldsuite/flow-domain/approvals';
import {
  DECISION_MESSAGES,
  decideInputError,
  decideStateError,
  decisionApprovalRows,
  decisionCode,
  decisionCreateError,
  decisionEditLockedError,
  decisionEventData,
  decisionSequence,
  mayRecordDecision,
  needsRerouting,
  normalizeOptions,
  optionsAfterDecide,
  optionsError,
  presentDecision,
  presentDecisionApproval,
  supersedeSourceError,
  supersedeTargetError,
} from '@weldsuite/flow-domain/decisions';
import { controlLinkEventData } from '@weldsuite/flow-domain/raid';
import { allocateNumber } from '@weldsuite/flow-domain/task-numbering';
import type { Env, Variables } from '../../types';
import {
  accessibleProjectIds,
  canAccessProject,
  canManageProject,
  canWriteProject,
  inAccessibleProjects,
} from '../../lib/project-access';
import {
  PROJECT_DENIED,
  PROJECT_MANAGE_DENIED,
  PROJECT_WRITE_DENIED,
  parseBody,
  readQuery,
  toDate,
  type AppContext,
} from '../../lib/governance-request';
import { containsPattern, parseLimit } from '../../lib/query-params';
import { liveProjectExists, linksOfObject, presentLinkedObjects } from '../../services/project-raid';
import {
  decisionsReplacedBy,
  findDecision,
  findDecisionRef,
  newDecisionValues,
  type DecisionRow,
} from '../../services/project-decisions';
import { announceApprovalsCancelled, announceApprovalsRequested, projectNamesOf } from '../../services/approvals';
import '../../services/governance-approvals';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectDecisions;
const linksTable = schema.projectControlLinks;

const DECISION_LABEL = 'Decision';

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(DECISION_STATUSES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Events ──────────────────────────────────────────────────────────────────

type DecisionAction = 'created' | 'updated' | 'deleted' | 'decided' | 'superseded';

function publishDecision(c: AppContext, action: DecisionAction, row: DecisionRow, extra: Record<string, unknown> = {}) {
  publishEntityEvent({
    c,
    entityType: 'project_decision',
    entityId: row.id,
    action,
    data: { ...decisionEventData(row), ...extra },
  });
}

function publishLink(c: AppContext, row: typeof linksTable.$inferSelect) {
  publishEntityEvent({
    c,
    entityType: 'project_control_link',
    entityId: row.id,
    action: 'deleted',
    data: controlLinkEventData(row),
  });
}

/** Announce that `rows` were asked about `row`: `flow_approval.requested`, the notifications and the reminder mark. */
async function announceAsked(c: AppContext, row: DecisionRow, rows: readonly ApprovalRow[]): Promise<void> {
  if (rows.length === 0) return;
  const projectName = (await projectNamesOf(c.get('tenantDb'), [row.projectId])).get(row.projectId) ?? null;
  announceApprovalsRequested(c, { rows, subject: { code: decisionCode(row.number), title: row.title }, projectName });
}

/** Ask the named decider: the approval rows of a proposed decision (the caller publishes their events). */
async function askDecider(c: AppContext, row: DecisionRow, userId: string): Promise<ApprovalRow[]> {
  if (row.status !== 'proposed' || !row.deciderId) return [];
  const requested = await requestApprovals(c.get('tenantDb'), {
    projectId: row.projectId,
    subjectType: 'decision',
    subjectId: row.id,
    requestedBy: userId,
    rows: decisionApprovalRows(row.deciderId, row.decisionDueAt),
  });
  if (!requested.ok) throw new Error(requested.message);
  return requested.rows;
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listQuerySchema);
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
    conditions.push(or(ilike(t.title, pattern), ilike(t.context, pattern)) as SQL);
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
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data.map(presentDecision), cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[flow-api/project-decisions] list failed:', err);
    return error.internal(c, 'Failed to list decisions');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findDecision(db, id);
    if (!row) return error.notFound(c, DECISION_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);

    const [linkRows, approvalRows, supersededBy, supersedes] = await Promise.all([
      linksOfObject(db, 'decision', id),
      listSubjectApprovals(db, 'decision', id),
      findDecisionRef(db, row.supersededById),
      decisionsReplacedBy(db, id),
    ]);
    const links = await presentLinkedObjects(
      db,
      linkRows,
      (link) => (link.fromType === 'decision' && link.fromId === id ? 'outgoing' : 'incoming'),
      (projectId) => canAccessProject(c, projectId),
    );
    return success(c, {
      ...presentDecision(row),
      links,
      approvals: approvalRows.map(presentDecisionApproval),
      supersededBy,
      supersedes,
    });
  } catch (err) {
    console.error('[flow-api/project-decisions] get failed:', err);
    return error.internal(c, 'Failed to fetch decision');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createDecisionSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const status = input.status ?? 'proposed';
  const options = normalizeOptions(input.options);
  const fieldError = decisionCreateError({
    status,
    options,
    deciderId: input.deciderId,
    decisionDueAt: input.decisionDueAt,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt,
  });
  if (fieldError) return error.badRequest(c, fieldError);

  let id: string | null = null;
  try {
    const now = new Date();
    id = generateId('dec');
    const number = await allocateNumber(db, decisionSequence(input.projectId));
    const values = newDecisionValues(
      {
        projectId: input.projectId,
        title: input.title,
        context: input.context,
        options,
        consequences: input.consequences,
        status,
        deciderId: input.deciderId,
        decisionDueAt: toDate(input.decisionDueAt),
        decidedBy: input.decidedBy,
        decidedAt: toDate(input.decidedAt),
      },
      { id, number, userId, now },
    );
    await atomically(db, (handle) => [handle.insert(t).values(values)]);
    const row = await findDecision(db, id);
    if (!row) return error.internal(c, 'Failed to create decision');

    const asked = await askDecider(c, row, userId);

    publishDecision(c, 'created', row);
    if (row.status === 'decided') publishDecision(c, 'decided', row);
    await announceAsked(c, row, asked);
    return success(c, presentDecision(row), 201);
  } catch (err) {
    console.error('[flow-api/project-decisions] create failed:', err);
    if (id) {
      const taken = new Date();
      await db
        .update(t)
        .set({ deletedAt: taken, updatedAt: taken })
        .where(eq(t.id, id))
        .catch((undoErr: unknown) => console.error('[flow-api/project-decisions] decision rollback failed:', undoErr));
    }
    return error.internal(c, 'Failed to create decision');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findDecision(db, id);
  if (!existing) return error.notFound(c, DECISION_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateDecisionSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const locked = decisionEditLockedError(existing.status, input);
  if (locked) return error.conflict(c, locked);
  const options = input.options !== undefined ? normalizeOptions(input.options) : undefined;
  if (options) {
    const optionError = optionsError(options);
    if (optionError) return error.badRequest(c, optionError);
  }

  try {
    const now = new Date();
    const set: Partial<typeof t.$inferInsert> = { updatedAt: now };
    if (input.title !== undefined) set.title = input.title;
    if (input.context !== undefined) set.context = input.context;
    if (options !== undefined) set.options = options;
    if (input.consequences !== undefined) set.consequences = input.consequences;
    if (input.deciderId !== undefined) set.deciderId = input.deciderId;
    if (input.decisionDueAt !== undefined) set.decisionDueAt = toDate(input.decisionDueAt);

    const existingApprovals = existing.status === 'proposed' ? await listSubjectApprovals(db, 'decision', id) : [];
    const nextDeciderId = input.deciderId !== undefined ? input.deciderId : existing.deciderId;
    const nextDueAt = input.decisionDueAt !== undefined ? toDate(input.decisionDueAt) : existing.decisionDueAt;
    const reroute =
      existing.status === 'proposed' &&
      (input.deciderId !== undefined || input.decisionDueAt !== undefined) &&
      needsRerouting({
        existingDeciderId: existing.deciderId,
        nextDeciderId,
        existingDueAt: existing.decisionDueAt,
        nextDueAt,
        approvals: existingApprovals,
      });

    await atomically(db, (handle) => [handle.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)))]);
    const row = await findDecision(db, id);
    if (!row) return error.notFound(c, DECISION_LABEL, id);
    publishDecision(c, 'updated', row);

    if (reroute) {
      // Asked again from scratch: the decider or the date changed, or the proposal was declined.
      const cleared = await cancelPendingApprovals(db, { subjectType: 'decision', subjectId: id, includeDecided: true });
      announceApprovalsCancelled(c, cleared);
      await announceAsked(c, row, await askDecider(c, row, userId));
    }
    return success(c, presentDecision(row));
  } catch (err) {
    console.error('[flow-api/project-decisions] update failed:', err);
    return error.internal(c, 'Failed to update decision');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findDecision(db, id);
    if (!existing) return error.notFound(c, DECISION_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    const linkRows = await linksOfObject(db, 'decision', id);
    const now = new Date();
    // The decision's links go with it, and the decisions it replaced take their place again.
    const replaced = await db
      .select()
      .from(t)
      .where(and(eq(t.supersededById, id), isNull(t.deletedAt)));
    await atomically(db, (handle) => [
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle
        .delete(linksTable)
        .where(
          or(
            and(eq(linksTable.fromType, 'decision'), eq(linksTable.fromId, id)),
            and(eq(linksTable.toType, 'decision'), eq(linksTable.toId, id)),
          ),
        ),
      handle
        .update(t)
        .set({ status: 'decided', supersededById: null, updatedAt: now })
        .where(and(eq(t.supersededById, id), isNull(t.deletedAt))),
    ]);
    publishEntityEvent({
      c,
      entityType: 'project_decision',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, code: decisionCode(existing.number) },
    });
    for (const link of linkRows) publishLink(c, link);
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'decision', subjectId: id, includeDecided: true }));
    for (const source of replaced) {
      const reverted = await findDecision(db, source.id);
      if (reverted) publishDecision(c, 'updated', reverted);
    }
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-decisions] delete failed:', err);
    return error.internal(c, 'Failed to delete decision');
  }
});

// ── Decide ──────────────────────────────────────────────────────────────────

app.post('/:id/decide', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findDecision(db, id);
  if (!existing) return error.notFound(c, DECISION_LABEL, id);
  if (!(await canAccessProject(c, existing.projectId))) return error.forbidden(c, PROJECT_DENIED);
  const mayRecord = mayRecordDecision({
    isManager: await canManageProject(c, existing.projectId),
    isNamedDecider: existing.deciderId !== null && existing.deciderId === userId,
  });
  if (!mayRecord) return error.forbidden(c, DECISION_MESSAGES.notDeciderOrManager);
  const body = await parseBody(c, decideDecisionSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const stateError = decideStateError(existing.status);
  if (stateError) return error.conflict(c, stateError);
  const options = normalizeOptions(existing.options);
  const inputError = decideInputError(options, input.chosenIndex);
  if (inputError) return error.badRequest(c, inputError);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({
          status: 'decided',
          options: optionsAfterDecide(options, input.chosenIndex),
          decidedBy: input.decidedBy ?? userId,
          decidedAt: toDate(input.decidedAt) ?? now,
          updatedAt: now,
        })
        .where(and(eq(t.id, id), eq(t.status, 'proposed'), isNull(t.deletedAt))),
    ]);
    const row = await findDecision(db, id);
    if (!row) return error.internal(c, 'Failed to record decision');

    publishDecision(c, 'decided', row);
    // Nobody is asked about a decision that is taken.
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'decision', subjectId: id }));
    return success(c, presentDecision(row));
  } catch (err) {
    console.error('[flow-api/project-decisions] decide failed:', err);
    return error.internal(c, 'Failed to record decision');
  }
});

// ── Supersede ───────────────────────────────────────────────────────────────

app.post('/:id/supersede', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findDecision(db, id);
  if (!existing) return error.notFound(c, DECISION_LABEL, id);
  if (!(await canAccessProject(c, existing.projectId))) return error.forbidden(c, PROJECT_DENIED);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, supersedeDecisionSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const sourceError = supersedeSourceError(existing.status);
  if (sourceError) return error.conflict(c, sourceError);
  const target = await findDecision(db, input.supersededById);
  if (!target) return error.notFound(c, DECISION_LABEL, input.supersededById);
  const targetError = supersedeTargetError(existing, target);
  if (targetError) {
    return targetError.status === 409 ? error.conflict(c, targetError.message) : error.badRequest(c, targetError.message);
  }

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ status: 'superseded', supersededById: target.id, updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    const row = await findDecision(db, id);
    if (!row) return error.internal(c, 'Failed to supersede decision');
    publishDecision(c, 'superseded', row, { supersededByCode: decisionCode(target.number) });
    return success(c, presentDecision(row));
  } catch (err) {
    console.error('[flow-api/project-decisions] supersede failed:', err);
    return error.internal(c, 'Failed to supersede decision');
  }
});

export const projectDecisionsRoutes = app;

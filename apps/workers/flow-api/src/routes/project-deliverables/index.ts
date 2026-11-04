/**
 * Deliverable routes: /api/project-deliverables/*, backed by
 * `project_deliverables` (design: weldflow-project-control.md; ADRs FLOW-011
 * and FLOW-016).
 *
 *   GET    /                    list in position order (projectId optional, filters, cursor)
 *   GET    /:id                 deliverable, links and its sign-off
 *   POST   /                    create (code D<n>, acceptance criteria)
 *   PATCH  /:id                 edit (once accepted, only visibility and position)
 *   DELETE /:id                 soft delete, with its links and open sign-off; its tasks lose the deliverable
 *   POST   /:id/request-signoff ask the sponsor and then, optionally, a client contact
 *   POST   /:id/accept          the project manager accepts directly
 *   POST   /:id/reject          the project manager rejects
 *
 * Tasks count toward a deliverable through `tasks.deliverable_id`; its progress
 * is computed from them on read. A full sign-off (every step approved) accepts
 * the deliverable, one rejection rejects it.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001); signing off, accepting and
 * rejecting are the project manager's (`canManageProject`). The checks run in a
 * fixed order so every backend answers alike: permission, then the deliverable
 * (404), then project access (403), then the body (400), then the business
 * rules.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  DELIVERABLE_STATUSES,
  createDeliverableSchema,
  rejectDeliverableSchema,
  requestSignoffSchema,
  updateDeliverableSchema,
} from '@weldsuite/app-api-client/schemas/project-governance';
import {
  cancelPendingApprovals,
  listSubjectApprovals,
  requestApprovals,
  sponsorOf,
} from '@weldsuite/flow-domain/approvals';
import {
  DELIVERABLE_MESSAGES,
  acceptError,
  acceptedEditError,
  applyCriteria,
  deliverableCode,
  deliverableDatesError,
  deliverableEventData,
  deliverableSequence,
  presentDeliverable,
  presentSignoffApproval,
  rejectError,
  signoffApprovalRows,
  signoffIsOpen,
} from '@weldsuite/flow-domain/deliverables';
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
  findDeliverable,
  newDeliverableValues,
  nextDeliverablePosition,
  raidForDeliverables,
  taskProgressForDeliverables,
  type DeliverableRow,
} from '../../services/project-deliverables';
import { announceApprovalsCancelled, announceApprovalsRequested, projectNamesOf } from '../../services/approvals';
import '../../services/governance-approvals';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectDeliverables;
const linksTable = schema.projectControlLinks;

const DELIVERABLE_LABEL = 'Deliverable';

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(DELIVERABLE_STATUSES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Events ──────────────────────────────────────────────────────────────────

function publishDeliverable(
  c: AppContext,
  action: 'created' | 'updated' | 'deleted' | 'accepted',
  row: DeliverableRow,
  extra: Record<string, unknown> = {},
) {
  publishEntityEvent({
    c,
    entityType: 'project_deliverable',
    entityId: row.id,
    action,
    data: { ...deliverableEventData(row), ...extra },
  });
}

/** The deliverable as every route answers it, with its task progress and register items. */
async function presentOne(c: AppContext, row: DeliverableRow) {
  const db = c.get('tenantDb');
  const [progress, raid] = await Promise.all([
    taskProgressForDeliverables(db, [row.id]),
    raidForDeliverables(db, [row.id]),
  ]);
  return presentDeliverable(row, progress.get(row.id) ?? { done: 0, total: 0 }, raid.get(row.id) ?? []);
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 50, 200);

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
    const [cur] = await db.select({ position: t.position, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(sql`(${t.position} > ${cur.position} OR (${t.position} = ${cur.position} AND ${t.id} > ${cur.id}))`);
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(asc(t.position), asc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const ids = data.map((row) => row.id);
    const [progress, raid] = await Promise.all([taskProgressForDeliverables(db, ids), raidForDeliverables(db, ids)]);
    return list(
      c,
      data.map((row) => presentDeliverable(row, progress.get(row.id) ?? { done: 0, total: 0 }, raid.get(row.id) ?? [])),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-deliverables] list failed:', err);
    return error.internal(c, 'Failed to list deliverables');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findDeliverable(db, id);
    if (!row) return error.notFound(c, DELIVERABLE_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);

    const [linkRows, signoffRows, base] = await Promise.all([
      linksOfObject(db, 'deliverable', id),
      listSubjectApprovals(db, 'deliverable', id),
      presentOne(c, row),
    ]);
    const links = await presentLinkedObjects(
      db,
      linkRows,
      (link) => (link.fromType === 'deliverable' && link.fromId === id ? 'outgoing' : 'incoming'),
      (projectId) => canAccessProject(c, projectId),
    );
    return success(c, { ...base, links, signoff: signoffRows.map(presentSignoffApproval) });
  } catch (err) {
    console.error('[flow-api/project-deliverables] get failed:', err);
    return error.internal(c, 'Failed to fetch deliverable');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createDeliverableSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const plannedStart = toDate(input.plannedStart);
  const plannedEnd = toDate(input.plannedEnd);
  const datesError = deliverableDatesError(plannedStart, plannedEnd);
  if (datesError) return error.badRequest(c, datesError);

  try {
    const now = new Date();
    const id = generateId('del');
    const number = await allocateNumber(db, deliverableSequence(input.projectId));
    const position = input.position ?? (await nextDeliverablePosition(db, input.projectId));
    const values = newDeliverableValues(
      {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        ownerId: input.ownerId,
        status: input.status,
        plannedStart,
        plannedEnd,
        acceptanceCriteria: applyCriteria([], input.acceptanceCriteria ?? [], now),
        clientVisible: input.clientVisible,
        position,
      },
      { id, number, userId, now },
    );
    await atomically(db, (handle) => [handle.insert(t).values(values)]);
    const row = await findDeliverable(db, id);
    if (!row) return error.internal(c, 'Failed to create deliverable');

    publishDeliverable(c, 'created', row);
    return success(c, presentDeliverable(row, { done: 0, total: 0 }, []), 201);
  } catch (err) {
    console.error('[flow-api/project-deliverables] create failed:', err);
    return error.internal(c, 'Failed to create deliverable');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

/** The columns an edit sets: only the fields it sent. */
function deliverableUpdateSet(
  input: z.infer<typeof updateDeliverableSchema>,
  existingCriteria: Parameters<typeof applyCriteria>[0],
  dates: { plannedStart: Date | null; plannedEnd: Date | null },
  now: Date,
): Partial<typeof t.$inferInsert> {
  const set: Partial<typeof t.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.ownerId !== undefined) set.ownerId = input.ownerId;
  if (input.status !== undefined) set.status = input.status;
  if (input.plannedStart !== undefined) set.plannedStart = dates.plannedStart;
  if (input.plannedEnd !== undefined) set.plannedEnd = dates.plannedEnd;
  if (input.acceptanceCriteria !== undefined) {
    set.acceptanceCriteria = applyCriteria(existingCriteria, input.acceptanceCriteria, now);
  }
  if (input.clientVisible !== undefined) set.clientVisible = input.clientVisible;
  if (input.position !== undefined) set.position = input.position;
  return set;
}

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findDeliverable(db, id);
  if (!existing) return error.notFound(c, DELIVERABLE_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateDeliverableSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const sent = Object.entries(input).filter(([, value]) => value !== undefined).map(([key]) => key);
  const locked = acceptedEditError(existing.status, sent);
  if (locked) return error.conflict(c, locked);
  const plannedStart = input.plannedStart !== undefined ? toDate(input.plannedStart) : existing.plannedStart;
  const plannedEnd = input.plannedEnd !== undefined ? toDate(input.plannedEnd) : existing.plannedEnd;
  const datesError = deliverableDatesError(plannedStart, plannedEnd);
  if (datesError) return error.badRequest(c, datesError);

  try {
    const now = new Date();
    const set = deliverableUpdateSet(input, existing.acceptanceCriteria, { plannedStart, plannedEnd }, now);

    await atomically(db, (handle) => [handle.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)))]);
    const row = await findDeliverable(db, id);
    if (!row) return error.notFound(c, DELIVERABLE_LABEL, id);

    publishDeliverable(c, 'updated', row);
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-deliverables] update failed:', err);
    return error.internal(c, 'Failed to update deliverable');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findDeliverable(db, id);
    if (!existing) return error.notFound(c, DELIVERABLE_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    const linkRows = await linksOfObject(db, 'deliverable', id);
    const now = new Date();
    // Its links go with it, and its tasks stop counting toward it, in the same batch.
    await atomically(db, (handle) => [
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt))),
      handle
        .delete(linksTable)
        .where(
          or(
            and(eq(linksTable.fromType, 'deliverable'), eq(linksTable.fromId, id)),
            and(eq(linksTable.toType, 'deliverable'), eq(linksTable.toId, id)),
          ),
        ),
      handle.update(schema.tasks).set({ deliverableId: null }).where(eq(schema.tasks.deliverableId, id)),
    ]);
    publishEntityEvent({
      c,
      entityType: 'project_deliverable',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, code: deliverableCode(existing.number) },
    });
    for (const link of linkRows) {
      publishEntityEvent({
        c,
        entityType: 'project_control_link',
        entityId: link.id,
        action: 'deleted',
        data: controlLinkEventData(link),
      });
    }
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'deliverable', subjectId: id, includeDecided: true }));
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-deliverables] delete failed:', err);
    return error.internal(c, 'Failed to delete deliverable');
  }
});

// ── Sign-off, accept, reject ────────────────────────────────────────────────

/** The deliverable and the caller's right to manage its project, or the refusal. */
async function managedDeliverable(c: AppContext, id: string) {
  const db = c.get('tenantDb');
  const existing = await findDeliverable(db, id);
  if (!existing) return { ok: false as const, response: error.notFound(c, DELIVERABLE_LABEL, id) };
  if (!(await canAccessProject(c, existing.projectId))) return { ok: false as const, response: error.forbidden(c, PROJECT_DENIED) };
  if (!(await canManageProject(c, existing.projectId))) return { ok: false as const, response: error.forbidden(c, PROJECT_MANAGE_DENIED) };
  return { ok: true as const, existing };
}

app.post('/:id/request-signoff', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const found = await managedDeliverable(c, id);
  if (!found.ok) return found.response;
  const { existing } = found;
  const body = await parseBody(c, requestSignoffSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const notAcceptable = acceptError(existing);
  if (notAcceptable) return error.conflict(c, notAcceptable);
  const previous = await listSubjectApprovals(db, 'deliverable', id);
  if (signoffIsOpen(previous)) return error.conflict(c, DELIVERABLE_MESSAGES.signoffWaiting);
  const [project] = await db
    .select({ settings: schema.projects.settings, projectManagerId: schema.projects.projectManagerId })
    .from(schema.projects)
    .where(eq(schema.projects.id, existing.projectId))
    .limit(1);
  const sponsorId = sponsorOf(project?.settings ?? null, project?.projectManagerId ?? null);
  if (!sponsorId) return error.conflict(c, DELIVERABLE_MESSAGES.noSponsor);

  try {
    // An earlier, settled sign-off (declined) is replaced by the new request.
    const cleared =
      previous.length > 0 ? await cancelPendingApprovals(db, { subjectType: 'deliverable', subjectId: id, includeDecided: true }) : [];
    const requested = await requestApprovals(db, {
      projectId: existing.projectId,
      subjectType: 'deliverable',
      subjectId: id,
      requestedBy: userId,
      rows: signoffApprovalRows(sponsorId, input.contactId, toDate(input.dueAt)),
    });
    if (!requested.ok) return error.conflict(c, requested.message);

    announceApprovalsCancelled(c, cleared);
    announceApprovalsRequested(c, {
      rows: requested.rows,
      subject: { code: deliverableCode(existing.number), title: existing.title },
      projectName: (await projectNamesOf(db, [existing.projectId])).get(existing.projectId) ?? null,
    });
    const row = await findDeliverable(db, id);
    if (!row) return error.internal(c, 'Failed to request sign-off');
    return success(c, { deliverable: await presentOne(c, row), signoff: requested.rows.map(presentSignoffApproval) }, 201);
  } catch (err) {
    console.error('[flow-api/project-deliverables] request sign-off failed:', err);
    return error.internal(c, 'Failed to request sign-off');
  }
});

app.post('/:id/accept', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const found = await managedDeliverable(c, id);
  if (!found.ok) return found.response;
  const { existing } = found;

  const notAcceptable = acceptError(existing);
  if (notAcceptable) return error.conflict(c, notAcceptable);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ status: 'accepted', acceptedBy: userId, acceptedAt: now, updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    const row = await findDeliverable(db, id);
    if (!row) return error.internal(c, 'Failed to accept deliverable');

    publishDeliverable(c, 'accepted', row);
    // Nobody is asked to sign off a deliverable that is accepted.
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'deliverable', subjectId: id }));
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-deliverables] accept failed:', err);
    return error.internal(c, 'Failed to accept deliverable');
  }
});

app.post('/:id/reject', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const found = await managedDeliverable(c, id);
  if (!found.ok) return found.response;
  const { existing } = found;
  const body = await parseBody(c, rejectDeliverableSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const notRejectable = rejectError(existing.status);
  if (notRejectable) return error.conflict(c, notRejectable);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ status: 'rejected', updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    const row = await findDeliverable(db, id);
    if (!row) return error.internal(c, 'Failed to reject deliverable');

    publishDeliverable(c, 'updated', row, { note: input.note ?? null });
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'deliverable', subjectId: id }));
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-deliverables] reject failed:', err);
    return error.internal(c, 'Failed to reject deliverable');
  }
});

export const projectDeliverablesRoutes = app;

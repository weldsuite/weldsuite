/**
 * Stakeholder routes: /api/project-stakeholders/*, backed by
 * `project_stakeholders` and `project_raci` (design:
 * weldflow-delivery-and-portfolio.md; ADR FLOW-020 for the portal).
 *
 *   GET    /                          the register of a project (projectId required, cursor)
 *   GET    /raci/:projectId           the RACI matrix: one row per deliverable, change requests, go-live
 *   PUT    /raci/:projectId           replace every assignment of one subject (one A per subject)
 *   GET    /settings/:projectId       the communication plan
 *   PUT    /settings/:projectId       replace the communication plan (merge-write into projects.settings)
 *   GET    /:id                       one stakeholder
 *   POST   /                          add a member or a CRM contact (exactly one)
 *   PATCH  /:id                       edit organisation, role, influence, interest, attitude, notes ...
 *   DELETE /:id                       remove from the register, with its RACI cells and portal access
 *   POST   /:id/portal-invite         give a contact portal access and email the invitation
 *   DELETE /:id/portal-access         take the portal access away
 *
 * Permissions: projects:read for reads, projects:update for every write, plus
 * the project membership boundary (FLOW-001): reading takes membership,
 * editing the register and the RACI takes write access, and the communication
 * plan and the portal access (they let people outside in) take managing the
 * project. The checks run in a fixed order so every backend answers alike:
 * permission, then the object (404), then project access (403), then the body
 * (400), then the business rules.
 */

import { Hono } from 'hono';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  createStakeholderSchema,
  listStakeholdersQuerySchema,
  putCommunicationPlanSchema,
  putRaciSchema,
  updateStakeholderSchema,
  type RaciAssignment,
  type RaciSubject,
  type RaciSubjectType,
} from '@weldsuite/app-api-client/schemas/project-reporting';
import {
  ALREADY_STAKEHOLDER,
  CONTACT_NOT_FOUND,
  CONTACT_WITHOUT_EMAIL,
  DELIVERABLE_NOT_FOUND,
  MEMBER_NOT_FOUND,
  NOT_A_CONTACT,
  STAKEHOLDER_NOT_IN_PROJECT,
  changedStakeholders,
  identityError,
  presentStakeholder,
  raciAssignmentsError,
  raciSubjectError,
  sortAssignments,
  stakeholderEventData,
} from '@weldsuite/flow-domain/stakeholders';
import type { Env, Variables } from '../../types';
import { canAccessProject, canManageProject, canWriteProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { parseBody, readQuery, type AppContext } from '../../lib/reporting-request';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { sendPortalInvitation } from '../../lib/report-notifications';
import { loadReportProject } from '../../services/status-reports';
import {
  contactExists,
  findStakeholder,
  identitiesOf,
  identityOf,
  liveProjectExists,
  memberExists,
  memberIdentities,
  stakeholdersOfProject,
  toDate,
  type StakeholderRow,
} from '../../services/stakeholders';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectStakeholders;
const raci = schema.projectRaci;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
const PROJECT_MANAGE_DENIED = 'You do not have manage access to this project';
const STAKEHOLDER_LABEL = 'Stakeholder';

// ── Helpers ─────────────────────────────────────────────────────────────────

function publishStakeholder(c: AppContext, action: 'created' | 'updated' | 'deleted', row: StakeholderRow, extra: Record<string, unknown> = {}) {
  publishEntityEvent({
    c,
    entityType: 'project_stakeholder',
    entityId: row.id,
    action,
    data: { ...stakeholderEventData(row), ...extra },
  });
}

/** The stakeholder as every route answers it. */
async function presentOne(c: AppContext, row: StakeholderRow) {
  const identities = await identitiesOf(c.get('tenantDb'), [row]);
  return presentStakeholder(row, identityOf(identities, row.id));
}

/** A merge write of one `projects.settings` key, with the `project.updated` event. */
async function writeSettingsKey(c: AppContext, projectId: string, key: string, value: unknown) {
  const db = c.get('tenantDb');
  await db
    .update(schema.projects)
    .set({
      settings: sql`(coalesce(${schema.projects.settings}, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  const [full] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  publishEntityEvent({
    c,
    entityType: 'project',
    entityId: projectId,
    action: 'updated',
    data: projectAnalyticsPayload((full ?? { id: projectId }) as Record<string, unknown>),
  });
}

// ── Communication plan ──────────────────────────────────────────────────────

// MUST be before /:id.
app.get('/settings/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    const project = await loadReportProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    return success(c, { projectId, communicationPlan: project.settings?.communicationPlan ?? [] });
  } catch (err) {
    console.error('[flow-api/project-stakeholders] communication plan failed:', err);
    return error.internal(c, 'Failed to load the communication plan');
  }
});

app.put('/settings/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, putCommunicationPlanSchema);
  if (!body.ok) return body.response;

  try {
    await writeSettingsKey(c, projectId, 'communicationPlan', body.data.communicationPlan);
    return success(c, { projectId, communicationPlan: body.data.communicationPlan });
  } catch (err) {
    console.error('[flow-api/project-stakeholders] communication plan update failed:', err);
    return error.internal(c, 'Failed to update the communication plan');
  }
});

// ── RACI ────────────────────────────────────────────────────────────────────

const SUBJECT_ORDER: RaciSubjectType[] = ['change_requests', 'go_live'];

function subjectKey(type: string, id: string | null): string {
  return `${type}:${id ?? ''}`;
}

async function raciRows(c: AppContext, projectId: string) {
  return c.get('tenantDb').select().from(raci).where(eq(raci.projectId, projectId)).orderBy(asc(raci.createdAt), asc(raci.id));
}

// MUST be before /:id.
app.get('/raci/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);

    const [register, deliverables, rows] = await Promise.all([
      stakeholdersOfProject(db, projectId),
      db
        .select({ id: schema.projectDeliverables.id, number: schema.projectDeliverables.number, title: schema.projectDeliverables.title })
        .from(schema.projectDeliverables)
        .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)))
        .orderBy(asc(schema.projectDeliverables.position), asc(schema.projectDeliverables.number)),
      raciRows(c, projectId),
    ]);
    const order = register.map((row) => row.id);
    const cells = new Map<string, RaciAssignment[]>();
    for (const row of rows) {
      const key = subjectKey(row.subjectType, row.subjectId);
      cells.set(key, [...(cells.get(key) ?? []), { stakeholderId: row.stakeholderId, letter: row.letter }]);
    }
    const assignmentsOf = (type: string, id: string | null) => sortAssignments(cells.get(subjectKey(type, id)) ?? [], order);
    const subjects: RaciSubject[] = [
      ...deliverables.map((row) => ({
        subjectType: 'deliverable' as const,
        subjectId: row.id,
        code: `D${row.number}`,
        title: row.title,
        assignments: assignmentsOf('deliverable', row.id),
      })),
      ...SUBJECT_ORDER.map((type) => ({ subjectType: type, subjectId: null, code: null, title: null, assignments: assignmentsOf(type, null) })),
    ];
    return success(c, { projectId, subjects });
  } catch (err) {
    console.error('[flow-api/project-stakeholders] raci failed:', err);
    return error.internal(c, 'Failed to load the RACI matrix');
  }
});

app.put('/raci/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  if (!(await liveProjectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canWriteProject(c, projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, putRaciSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const subjectId = input.subjectType === 'deliverable' ? (input.subjectId ?? null) : null;
  const subjectError = raciSubjectError(input.subjectType, input.subjectId);
  if (subjectError) return error.badRequest(c, subjectError);
  const assignmentsError = raciAssignmentsError(input.assignments);
  if (assignmentsError) return error.badRequest(c, assignmentsError);

  try {
    let deliverable: { number: number; title: string } | null = null;
    if (subjectId) {
      const [row] = await db
        .select({ number: schema.projectDeliverables.number, title: schema.projectDeliverables.title })
        .from(schema.projectDeliverables)
        .where(and(eq(schema.projectDeliverables.id, subjectId), eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)))
        .limit(1);
      if (!row) return error.badRequest(c, DELIVERABLE_NOT_FOUND);
      deliverable = row;
    }
    const register = await stakeholdersOfProject(db, projectId);
    const known = new Map(register.map((row) => [row.id, row]));
    if (input.assignments.some((assignment) => !known.has(assignment.stakeholderId))) {
      return error.badRequest(c, STAKEHOLDER_NOT_IN_PROJECT);
    }

    const before = (await raciRows(c, projectId))
      .filter((row) => row.subjectType === input.subjectType && (row.subjectId ?? null) === subjectId)
      .map((row) => ({ stakeholderId: row.stakeholderId, letter: row.letter }));
    const now = new Date();
    const subjectMatch = and(
      eq(raci.projectId, projectId),
      eq(raci.subjectType, input.subjectType),
      subjectId ? eq(raci.subjectId, subjectId) : isNull(raci.subjectId),
    );
    await atomically(db, (handle) => [
      handle.delete(raci).where(subjectMatch),
      ...(input.assignments.length > 0
        ? [
            handle.insert(raci).values(
              input.assignments.map((assignment) => ({
                id: generateId('rac'),
                projectId,
                subjectType: input.subjectType,
                subjectId,
                stakeholderId: assignment.stakeholderId,
                letter: assignment.letter,
                createdBy: userId,
                createdAt: now,
                updatedAt: now,
              })),
            ),
          ]
        : []),
    ]);

    // A cell is a relation, not an entity: the stakeholders' events are its trail.
    const order = register.map((row) => row.id);
    for (const id of changedStakeholders(before, input.assignments)) {
      const row = known.get(id);
      if (!row) continue;
      publishStakeholder(c, 'updated', row, {
        raci: {
          subjectType: input.subjectType,
          subjectId,
          letters: input.assignments.filter((assignment) => assignment.stakeholderId === id).map((assignment) => assignment.letter),
        },
      });
    }
    return success(c, {
      subjectType: input.subjectType,
      subjectId,
      code: deliverable ? `D${deliverable.number}` : null,
      title: deliverable?.title ?? null,
      assignments: sortAssignments(input.assignments, order),
    });
  } catch (err) {
    console.error('[flow-api/project-stakeholders] raci update failed:', err);
    return error.internal(c, 'Failed to update the RACI matrix');
  }
});

// ── Register: reads ─────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listStakeholdersQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 100, 200);
  if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);

  const conditions = [isNull(t.deletedAt), eq(t.projectId, q.projectId)];
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) conditions.push(sql`(${t.createdAt} > ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} > ${cur.id}))`);
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(asc(t.createdAt), asc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const identities = await identitiesOf(db, data);
    return list(
      c,
      data.map((row) => presentStakeholder(row, identityOf(identities, row.id))),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-stakeholders] list failed:', err);
    return error.internal(c, 'Failed to list stakeholders');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findStakeholder(db, id);
    if (!row) return error.notFound(c, STAKEHOLDER_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-stakeholders] get failed:', err);
    return error.internal(c, 'Failed to fetch stakeholder');
  }
});

// ── Register: writes ────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createStakeholderSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const identity = identityError(input.memberId, input.crmContactId);
  if (identity) return error.badRequest(c, identity);

  try {
    if (input.memberId) {
      if (!(await memberExists(db, input.memberId))) return error.badRequest(c, MEMBER_NOT_FOUND);
    } else if (input.crmContactId) {
      if (!(await contactExists(db, input.crmContactId))) return error.badRequest(c, CONTACT_NOT_FOUND);
    }
    const [duplicate] = await db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.projectId, input.projectId),
          isNull(t.deletedAt),
          input.memberId ? eq(t.memberId, input.memberId) : eq(t.crmContactId, input.crmContactId as string),
        ),
      )
      .limit(1);
    if (duplicate) return error.conflict(c, ALREADY_STAKEHOLDER);

    const now = new Date();
    const id = generateId('stk');
    await db.insert(t).values({
      id,
      projectId: input.projectId,
      memberId: input.memberId || null,
      crmContactId: input.crmContactId || null,
      organisation: input.organisation ?? null,
      role: input.role ?? null,
      influence: input.influence ?? 3,
      interest: input.interest ?? 3,
      attitude: input.attitude ?? 'neutral',
      engagement: input.engagement ?? 'neutral',
      notes: input.notes ?? null,
      lastContactAt: toDate(input.lastContactAt),
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const row = await findStakeholder(db, id);
    if (!row) return error.internal(c, 'Failed to create stakeholder');

    publishStakeholder(c, 'created', row);
    return success(c, await presentOne(c, row), 201);
  } catch (err) {
    console.error('[flow-api/project-stakeholders] create failed:', err);
    return error.internal(c, 'Failed to create stakeholder');
  }
});

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findStakeholder(db, id);
  if (!existing) return error.notFound(c, STAKEHOLDER_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateStakeholderSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  try {
    const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
    for (const field of ['organisation', 'role', 'influence', 'interest', 'attitude', 'engagement', 'notes'] as const) {
      if (input[field] !== undefined) (set as Record<string, unknown>)[field] = input[field];
    }
    if (input.lastContactAt !== undefined) set.lastContactAt = toDate(input.lastContactAt);
    await db.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const row = await findStakeholder(db, id);
    if (!row) return error.notFound(c, STAKEHOLDER_LABEL, id);

    publishStakeholder(c, 'updated', row);
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-stakeholders] update failed:', err);
    return error.internal(c, 'Failed to update stakeholder');
  }
});

app.delete('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findStakeholder(db, id);
    if (!existing) return error.notFound(c, STAKEHOLDER_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    // The person leaves the register together with their RACI cells and their portal access.
    const now = new Date();
    await atomically(db, (handle) => [
      handle.delete(raci).where(eq(raci.stakeholderId, id)),
      handle.update(t).set({ deletedAt: now, updatedAt: now, portalAccess: false }).where(and(eq(t.id, id), isNull(t.deletedAt))),
    ]);
    publishStakeholder(c, 'deleted', { ...existing, deletedAt: now, updatedAt: now, portalAccess: false });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-stakeholders] delete failed:', err);
    return error.internal(c, 'Failed to delete stakeholder');
  }
});

// ── Portal access ───────────────────────────────────────────────────────────

app.post('/:id/portal-invite', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findStakeholder(db, id);
  if (!existing) return error.notFound(c, STAKEHOLDER_LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  if (!existing.crmContactId) return error.badRequest(c, NOT_A_CONTACT);

  try {
    const identities = await identitiesOf(db, [existing]);
    const contact = identityOf(identities, id);
    if (!contact.email) return error.badRequest(c, CONTACT_WITHOUT_EMAIL);

    const now = new Date();
    await db.update(t).set({ portalAccess: true, portalInvitedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const row = await findStakeholder(db, id);
    if (!row) return error.notFound(c, STAKEHOLDER_LABEL, id);

    publishStakeholder(c, 'updated', row);
    const project = await loadReportProject(db, row.projectId);
    if (project) {
      const inviter = (await memberIdentities(db, [userId])).get(userId);
      c.executionCtx.waitUntil(
        sendPortalInvitation(
          { env: c.env, db, workspaceId: c.get('workspaceId'), clerkOrgId: c.get('clerkOrgId'), actorId: userId },
          { project, contact: { id: existing.crmContactId, name: contact.name, email: contact.email }, inviterName: inviter?.name ?? null },
        ).catch((err) => console.error('[flow-api/project-stakeholders] invitation failed:', err)),
      );
    }
    return success(c, presentStakeholder(row, contact));
  } catch (err) {
    console.error('[flow-api/project-stakeholders] portal invite failed:', err);
    return error.internal(c, 'Failed to invite the contact to the portal');
  }
});

app.delete('/:id/portal-access', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findStakeholder(db, id);
  if (!existing) return error.notFound(c, STAKEHOLDER_LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);

  try {
    await db.update(t).set({ portalAccess: false, updatedAt: new Date() }).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const row = await findStakeholder(db, id);
    if (!row) return error.notFound(c, STAKEHOLDER_LABEL, id);

    publishStakeholder(c, 'updated', row);
    return success(c, await presentOne(c, row));
  } catch (err) {
    console.error('[flow-api/project-stakeholders] portal access removal failed:', err);
    return error.internal(c, 'Failed to remove the portal access');
  }
});

export const projectStakeholdersRoutes = app;

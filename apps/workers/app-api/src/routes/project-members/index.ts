/**
 * Project member routes — /api/project-members/*.
 *
 * Membership of a project, with role + allocation + hourly rate. Routes
 * mirror the api-worker shape the WeldFlow UI is built around: list joins
 * `workspaceMembers` for user metadata, `/available` returns workspace users
 * not yet on the project, `/by-user/:projectId/:userId` resolves the row by
 * (projectId, userId) so the UI can use Clerk userIds without first looking
 * up the synthetic member row id.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { canAccessProject, canManageProject } from '../../lib/project-access';

const MANAGE_MEMBERS_DENIED = 'You must be a project owner, admin, or manager to manage its members';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectMembers;

const addMemberSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string().default('member'),
  permissions: z.array(z.string()).optional(),
  allocationPercentage: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v != null ? String(v) : undefined)),
  hourlyRate: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v != null ? String(v) : undefined)),
});

const updateMemberSchema = z.object({
  role: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  allocationPercentage: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v != null ? String(v) : undefined)),
  hourlyRate: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v != null ? String(v) : undefined)),
  isActive: z.boolean().optional(),
});

async function getActiveMemberIds(db: any, projectId: string): Promise<string[]> {
  const rows: { userId: string }[] = await db
    .select({ userId: t.userId })
    .from(t)
    .where(and(eq(t.projectId, projectId), eq(t.isActive, true), isNull(t.deletedAt)));
  return rows.map((r) => r.userId);
}

// ============================================================================
// GET / — list active members for a project, joined with workspaceMembers for
// display fields (name, email, avatar).
// ============================================================================

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.query('projectId');
  if (!projectId) return error.badRequest(c, 'Missing required query param: projectId');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }

  try {
    const { workspaceMembers } = schema;
    const results = await db
      .select({
        id: t.id,
        projectId: t.projectId,
        userId: t.userId,
        role: t.role,
        permissions: t.permissions,
        isActive: t.isActive,
        joinedAt: t.joinedAt,
        leftAt: t.leftAt,
        allocationPercentage: t.allocationPercentage,
        hourlyRate: t.hourlyRate,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        user: {
          id: workspaceMembers.userId,
          name: workspaceMembers.name,
          email: workspaceMembers.email,
          avatar: workspaceMembers.picture,
        },
      })
      .from(t)
      .leftJoin(workspaceMembers, eq(t.userId, workspaceMembers.userId))
      .where(and(eq(t.projectId, projectId), eq(t.isActive, true), isNull(t.deletedAt)));
    return success(c, results);
  } catch (err) {
    console.error('[app-api/project-members] list failed:', err);
    return error.internal(c, 'Failed to list project members');
  }
});

// ============================================================================
// GET /available — workspace users not already on this project
// ============================================================================

app.get('/available', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.query('projectId');
  if (!projectId) return error.badRequest(c, 'Missing required query param: projectId');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }

  try {
    const { workspaceMembers } = schema;
    const existing = await db
      .select({ userId: t.userId })
      .from(t)
      .where(and(eq(t.projectId, projectId), eq(t.isActive, true), isNull(t.deletedAt)));
    const existingIds = existing.map((m) => m.userId);

    const conditions: any[] = [isNull(workspaceMembers.deletedAt), eq(workspaceMembers.status, 'ACTIVE')];
    if (existingIds.length > 0) {
      conditions.push(
        sql`${workspaceMembers.userId} NOT IN (${sql.join(
          existingIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }

    const available = await db
      .select({
        id: workspaceMembers.userId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        image: workspaceMembers.picture,
      })
      .from(workspaceMembers)
      .where(and(...conditions));
    return success(c, available);
  } catch (err) {
    console.error('[app-api/project-members] available failed:', err);
    return error.internal(c, 'Failed to fetch available users');
  }
});

// ============================================================================
// GET /by-user/:projectId/:userId — fetch a member row by composite key
// (matches `membersApi.get(projectId, userId)` shape).
// ============================================================================

app.get('/by-user/:projectId/:userId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const userId = c.req.param('userId');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }
  try {
    const { workspaceMembers } = schema;
    const [row] = await db
      .select({
        id: t.id,
        projectId: t.projectId,
        userId: t.userId,
        role: t.role,
        permissions: t.permissions,
        isActive: t.isActive,
        joinedAt: t.joinedAt,
        leftAt: t.leftAt,
        allocationPercentage: t.allocationPercentage,
        hourlyRate: t.hourlyRate,
        user: {
          id: workspaceMembers.userId,
          name: workspaceMembers.name,
          email: workspaceMembers.email,
          avatar: workspaceMembers.picture,
        },
      })
      .from(t)
      .leftJoin(workspaceMembers, eq(t.userId, workspaceMembers.userId))
      .where(and(eq(t.projectId, projectId), eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Project member', `${projectId}/${userId}`);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-members] by-user get failed:', err);
    return error.internal(c, 'Failed to fetch project member');
  }
});

// ============================================================================
// GET /by-user/:projectId/:userId/stats — task + time stats for one member.
// MVP returns empty/zeroed shape so the detail page doesn't 404; richer
// numbers are a follow-up that can join tasks + time-entries.
// ============================================================================

app.get('/by-user/:projectId/:userId/stats', requirePermission('projects:read'), async (c) => {
  return success(c, {
    tasksAssigned: 0,
    tasksCompleted: 0,
    hoursLogged: 0,
    overdue: 0,
  });
});

// ============================================================================
// POST / — add member (reactivates a soft-deleted row when present)
// ============================================================================

app.post(
  '/',
  requirePermission('projects:update'),
  zValidator('json', addMemberSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    // Row-level guard: `projects:update` gates the feature; managing a specific
    // project's members requires being that project's owner/admin/manager (or
    // holding projects:scope:all). Prevents self-escalation onto any project.
    if (!(await canManageProject(c, data.projectId))) {
      return error.forbidden(c, MANAGE_MEMBERS_DENIED);
    }
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.projectId, data.projectId), eq(t.userId, data.userId)))
        .limit(1);

      const now = new Date();
      if (existing) {
        if (existing.deletedAt || !existing.isActive) {
          await db
            .update(t)
            .set({
              isActive: true,
              deletedAt: null,
              role: data.role,
              permissions: data.permissions ?? null,
              allocationPercentage: data.allocationPercentage ?? null,
              hourlyRate: data.hourlyRate ?? null,
              joinedAt: now,
              updatedAt: now,
            })
            .where(eq(t.id, existing.id));
          const memberIds = await getActiveMemberIds(db, data.projectId);
          publishEntityEvent({
            c,
            entityType: 'project_member',
            entityId: existing.id,
            action: 'added',
            data: { id: existing.id, projectId: data.projectId, userId: data.userId, role: data.role },
            accessUserIds: memberIds,
          });
          return success(c, { id: existing.id }, 201);
        }
        return error.badRequest(c, 'User is already a member of this project');
      }

      const id = generateId('pmem');
      await db.insert(t).values({
        id,
        projectId: data.projectId,
        userId: data.userId,
        role: data.role,
        permissions: data.permissions ?? null,
        allocationPercentage: data.allocationPercentage ?? null,
        hourlyRate: data.hourlyRate ?? null,
        isActive: true,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof t.$inferInsert);
      const memberIds = await getActiveMemberIds(db, data.projectId);
      publishEntityEvent({
        c,
        entityType: 'project_member',
        entityId: id,
        action: 'added',
        data: { id, projectId: data.projectId, userId: data.userId, role: data.role },
        accessUserIds: memberIds,
      });
      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/project-members] add failed:', err);
      return error.internal(c, 'Failed to add project member');
    }
  },
);

// ============================================================================
// PATCH /by-user/:projectId/:userId — update by composite key. Frontend
// patterns (members-client, member detail page) already pass `member.userId`.
// ============================================================================

app.patch(
  '/by-user/:projectId/:userId',
  requirePermission('projects:update'),
  zValidator('json', updateMemberSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const projectId = c.req.param('projectId');
    const userId = c.req.param('userId');
    const data = c.req.valid('json');
    if (!(await canManageProject(c, projectId))) {
      return error.forbidden(c, MANAGE_MEMBERS_DENIED);
    }
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.projectId, projectId), eq(t.userId, userId), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Project member', `${projectId}/${userId}`);

      const update: Record<string, any> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
      await db.update(t).set(update).where(eq(t.id, existing.id));

      const memberIds = await getActiveMemberIds(db, projectId);
      publishEntityEvent({
        c,
        entityType: 'project_member',
        entityId: existing.id,
        action: 'updated',
        data: { id: existing.id, projectId, userId, ...data },
        accessUserIds: memberIds,
      });

      return success(c, { projectId, userId, ...data });
    } catch (err) {
      console.error('[app-api/project-members] update by-user failed:', err);
      return error.internal(c, 'Failed to update project member');
    }
  },
);

// ============================================================================
// DELETE /by-user/:projectId/:userId — remove by composite key
// ============================================================================

app.delete('/by-user/:projectId/:userId', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const userId = c.req.param('userId');
  if (!(await canManageProject(c, projectId))) {
    return error.forbidden(c, MANAGE_MEMBERS_DENIED);
  }
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.projectId, projectId), eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Project member', `${projectId}/${userId}`);

    const now = new Date();
    await db
      .update(t)
      .set({ isActive: false, leftAt: now, deletedAt: now, updatedAt: now })
      .where(eq(t.id, existing.id));

    // Notify remaining members AND the removed user so they all see the change.
    const memberIds = await getActiveMemberIds(db, projectId);
    memberIds.push(userId);
    publishEntityEvent({
      c,
      entityType: 'project_member',
      entityId: existing.id,
      action: 'removed',
      data: { id: existing.id, projectId, userId },
      accessUserIds: memberIds,
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-members] remove by-user failed:', err);
    return error.internal(c, 'Failed to remove project member');
  }
});

// ============================================================================
// GET /:id  — fallback by-row-id (kept for compat with anything that holds
// member row ids; the canonical access path is /by-user/...).
// ============================================================================

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project member', id);
    if (!(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, 'You are not a member of this project');
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-members] get failed:', err);
    return error.internal(c, 'Failed to fetch project member');
  }
});

export const projectMembersRoutes = app;

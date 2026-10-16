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
 * Roles are a closed set (owner | admin | member | viewer). Granting or
 * revoking `owner` is reserved for owners (and the project manager / scope:all
 * holders), and a project always keeps at least one owner. The hourly rate is
 * pay data: only project admins and the member themselves get it back.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { schema } from '@weldsuite/worker-kit/db';
import { canManageProject, mayAccess, resolveProjectAccess } from '../../lib/project-access';

const MANAGE_MEMBERS_DENIED = 'You must be a project owner, admin, or manager to manage its members';
const PROJECT_DENIED = 'You are not a member of this project';
const OWNER_CHANGE_DENIED = 'Only a project owner can grant or revoke the owner role';
const LAST_OWNER = 'A project needs at least one owner';
const NOT_A_WORKSPACE_MEMBER = 'User is not an active member of this workspace';
const ALREADY_MEMBER = 'User is already a member of this project';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectMembers;

type MemberCtx = Context<{ Bindings: Env; Variables: Variables }>;
type TenantDb = Variables['tenantDb'];

/** Project roles. Stored lowercase; legacy callers sending "Admin" are accepted. */
const PROJECT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const roleSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.enum(PROJECT_ROLES),
);

const addMemberSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  role: roleSchema.default('member'),
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
  role: roleSchema.optional(),
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

async function getActiveMemberIds(db: TenantDb, projectId: string): Promise<string[]> {
  const rows: { userId: string }[] = await db
    .select({ userId: t.userId })
    .from(t)
    .where(and(eq(t.projectId, projectId), eq(t.isActive, true), isNull(t.deletedAt)));
  return rows.map((r) => r.userId);
}

/** Entity-event payload without the pay data: events fan out to every project member. */
function withoutRate<T extends { hourlyRate?: unknown }>(data: T): Omit<T, 'hourlyRate'> {
  const { hourlyRate: _hourlyRate, ...rest } = data;
  return rest;
}

/** Read gate that also tells whether the caller may see pay data (project admins). */
async function readAccess(c: MemberCtx, projectId: string): Promise<{ allowed: boolean; isAdmin: boolean }> {
  const access = await resolveProjectAccess(c, projectId);
  return { allowed: mayAccess(access), isAdmin: access.isAdmin };
}

/** Project admins and the member themselves see the hourly rate; everyone else gets null. */
function redactRate<T extends { userId: string; hourlyRate: unknown }>(
  row: T,
  viewer: { userId: string | undefined; isAdmin: boolean },
): T {
  return viewer.isAdmin || row.userId === viewer.userId ? row : { ...row, hourlyRate: null };
}

/** May the caller grant / revoke the owner role on this project? */
async function canChangeOwners(c: MemberCtx, projectId: string): Promise<boolean> {
  const access = await resolveProjectAccess(c, projectId);
  return !access.deleted && (access.scopeAll || access.isManager || access.role === 'owner');
}

/**
 * Does the project keep an owner if `userId` stops being one? The project
 * manager counts (they resolve to the owner role without a member row).
 */
async function hasOtherOwner(db: TenantDb, projectId: string, userId: string): Promise<boolean> {
  const [project] = await db
    .select({ managerId: schema.projects.projectManagerId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (project?.managerId && project.managerId !== userId) return true;
  const [other] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.projectId, projectId),
        ne(t.userId, userId),
        sql`lower(${t.role}) = 'owner'`,
        eq(t.isActive, true),
        isNull(t.deletedAt),
      ),
    )
    .limit(1);
  return !!other;
}

/** Is `userId` an active member of this workspace? */
async function isWorkspaceMember(db: TenantDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.userId, userId),
        eq(schema.workspaceMembers.status, 'ACTIVE'),
        isNull(schema.workspaceMembers.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}

// ============================================================================
// GET / — list active members for a project, joined with workspaceMembers for
// display fields (name, email, avatar).
// ============================================================================

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.query('projectId');
  if (!projectId) return error.badRequest(c, 'Missing required query param: projectId');
  const access = await readAccess(c, projectId);
  if (!access.allowed) return error.forbidden(c, PROJECT_DENIED);
  const viewer = { userId: c.get('userId'), isAdmin: access.isAdmin };

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
    return success(c, results.map((row) => redactRate(row, viewer)));
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
  if (!(await readAccess(c, projectId)).allowed) {
    return error.forbidden(c, PROJECT_DENIED);
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
  const access = await readAccess(c, projectId);
  if (!access.allowed) {
    return error.forbidden(c, PROJECT_DENIED);
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
    return success(c, redactRate(row, { userId: c.get('userId'), isAdmin: access.isAdmin }));
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

app.get('/by-user/:projectId/:userId/stats', requirePermission('projects:read'), (c) => {
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
    if (data.role === 'owner' && !(await canChangeOwners(c, data.projectId))) {
      return error.forbidden(c, OWNER_CHANGE_DENIED);
    }
    try {
      if (!(await isWorkspaceMember(db, data.userId))) {
        return error.badRequest(c, NOT_A_WORKSPACE_MEMBER);
      }
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
        return error.badRequest(c, ALREADY_MEMBER);
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
      // (project_id, user_id) is unique: a concurrent add loses the race here.
      if (isUniqueViolation(err)) return error.badRequest(c, ALREADY_MEMBER);
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

      // Owner changes: only owners hand out or take back the owner role, and the
      // last owner cannot be demoted or deactivated.
      const currentRole = existing.role.toLowerCase();
      const nextRole = data.role ?? currentRole;
      const grantsOwner = nextRole === 'owner' && currentRole !== 'owner';
      const revokesOwner = currentRole === 'owner' && (nextRole !== 'owner' || data.isActive === false);
      if ((grantsOwner || revokesOwner) && !(await canChangeOwners(c, projectId))) {
        return error.forbidden(c, OWNER_CHANGE_DENIED);
      }
      if (revokesOwner && !(await hasOtherOwner(db, projectId, userId))) {
        return error.conflict(c, LAST_OWNER);
      }

      const update: Record<string, any> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
      await db.update(t).set(update).where(eq(t.id, existing.id));

      const memberIds = await getActiveMemberIds(db, projectId);
      publishEntityEvent({
        c,
        entityType: 'project_member',
        entityId: existing.id,
        action: 'updated',
        data: { id: existing.id, projectId, userId, ...withoutRate(data) },
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

    if (existing.role.toLowerCase() === 'owner') {
      if (!(await canChangeOwners(c, projectId))) return error.forbidden(c, OWNER_CHANGE_DENIED);
      if (!(await hasOtherOwner(db, projectId, userId))) return error.conflict(c, LAST_OWNER);
    }

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
    const access = await readAccess(c, row.projectId);
    if (!access.allowed) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, redactRate(row, { userId: c.get('userId'), isAdmin: access.isAdmin }));
  } catch (err) {
    console.error('[app-api/project-members] get failed:', err);
    return error.internal(c, 'Failed to fetch project member');
  }
});

export const projectMembersRoutes = app;

/**
 * Project routes — flat /api/projects/* surface backed by `projects`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createProjectSchema, updateProjectSchema } from '@weldsuite/app-api-client/schemas/projects';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { canAccessProject, canManageProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projects;

// Project visibility is driven by membership, NOT only the workspace-level
// `projects:read` object permission — so this route resolves access in-handler
// rather than hard-blocking via requirePermission:
//   - `projects:scope:all` (owners + admins) → every project in the workspace.
//   - otherwise → only projects the user manages (projectManagerId) or is an
//     active member of. A user added to a single project therefore sees it even
//     if their role doesn't grant the blanket `projects:read`.
app.get('/', async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const resolved = await ensurePermissionsResolved(c);
  const canSeeAll = hasPermission(resolved?.permissions ?? [], 'projects:scope:all');

  const conditions: any[] = [isNull(t.deletedAt)];
  if (!canSeeAll) {
    const memberships = await db
      .select({ projectId: schema.projectMembers.projectId })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
        ),
      );
    const memberProjectIds = memberships.map((m) => m.projectId);
    // Manager of the project OR an active member of it.
    conditions.push(
      memberProjectIds.length
        ? or(eq(t.projectManagerId, userId), inArray(t.id, memberProjectIds))!
        : eq(t.projectManagerId, userId),
    );
  }
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.isActive !== undefined && q.isActive !== '') {
    // Accept the truthy strings the WeldFlow UI sends (`?isActive=true`).
    conditions.push(eq(t.isActive, q.isActive === 'true' || q.isActive === '1'));
  }
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/projects] list failed:', err);
    return error.internal(c, 'Failed to list projects');
  }
});

// ============================================================================
// GET /workload/overview — cross-project workload aggregation.
// Registered BEFORE /search (and /:id) so the literal wins.
// ============================================================================

app.get('/workload/overview', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  try {
    const { projects, projectMembers, workspaceMembers, tasks } = schema;

    // Get project IDs where the current user is an active member.
    const userMemberships = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );

    const userProjectIds = userMemberships.map((m) => m.projectId);

    if (userProjectIds.length === 0) {
      return success(c, { totalProjects: 0, totalMembers: 0, totalTasks: 0, teamMembers: [] });
    }

    // All active members across the user's projects with workspace user details.
    const members = await db
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        allocationPercentage: projectMembers.allocationPercentage,
        hoursPerWeek: workspaceMembers.hoursPerWeek,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        avatar: workspaceMembers.picture,
      })
      .from(projectMembers)
      .leftJoin(workspaceMembers, eq(projectMembers.userId, workspaceMembers.userId))
      .where(
        and(
          inArray(projectMembers.projectId, userProjectIds),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );

    // Deduplicate members across projects — keep first occurrence.
    const uniqueMembers = new Map<string, (typeof members)[0]>();
    for (const m of members) {
      if (!uniqueMembers.has(m.userId)) uniqueMembers.set(m.userId, m);
    }

    // Active, assigned, non-terminal tasks across all user projects.
    const projectTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        assigneeId: tasks.assigneeId,
        status: tasks.status,
        priority: tasks.priority,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        estimatedHours: tasks.estimatedHours,
        actualHours: tasks.actualHours,
      })
      .from(tasks)
      .where(
        and(
          inArray(tasks.projectId, userProjectIds),
          isNull(tasks.deletedAt),
          sql`${tasks.assigneeId} is not null`,
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      );

    // Project name lookup for task enrichment.
    const projectList = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, userProjectIds));
    const projectNameMap = new Map(projectList.map((p) => [p.id, p.name]));

    // Group tasks by assignee.
    const tasksByAssignee = new Map<string, typeof projectTasks>();
    for (const task of projectTasks) {
      if (!task.assigneeId) continue;
      const existing = tasksByAssignee.get(task.assigneeId) ?? [];
      existing.push(task);
      tasksByAssignee.set(task.assigneeId, existing);
    }

    const totalTasks = projectTasks.length;

    const teamMembers = Array.from(uniqueMembers.values()).map((m) => {
      const memberTasks = tasksByAssignee.get(m.userId) ?? [];
      const hoursPerWeek = Number(m.hoursPerWeek) || 40;
      const capacity = Math.round(((Number(m.allocationPercentage) || 100) / 100) * hoursPerWeek);
      const initials = (m.name ?? m.email ?? m.userId).slice(0, 2).toUpperCase();
      return {
        userId: m.userId,
        name: m.name ?? m.email ?? m.userId,
        email: m.email ?? '',
        avatar: m.avatar ?? '',
        initials,
        role: m.role,
        capacity,
        tasks: memberTasks.map((t) => ({
          id: t.id,
          title: t.title,
          projectId: t.projectId,
          projectName: projectNameMap.get(t.projectId ?? '') ?? '',
          estimatedHours: t.estimatedHours ?? 0,
          actualHours: t.actualHours ?? 0,
          priority: t.priority ?? 'medium',
          status: t.status ?? 'todo',
          startDate: t.startDate ? t.startDate.toISOString() : null,
          dueDate: t.dueDate ? t.dueDate.toISOString() : null,
        })),
      };
    });

    return success(c, {
      totalProjects: userProjectIds.length,
      totalMembers: uniqueMembers.size,
      totalTasks,
      teamMembers,
    });
  } catch (err) {
    console.error('[app-api/projects] workload overview failed:', err);
    return error.internal(c, 'Failed to fetch workload overview');
  }
});

// ============================================================================
// GET /search?q= — search projects the current user is a member of.
// Registered BEFORE /:id so the literal wins over the param pattern.
// ============================================================================

app.get('/search', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const q = c.req.query('q') ?? '';
  try {
    const { projects, projectMembers } = schema;
    const memberships = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );
    const userProjectIds = memberships.map((m) => m.projectId);
    if (userProjectIds.length === 0) return success(c, []);

    const conditions: any[] = [isNull(projects.deletedAt), inArray(projects.id, userProjectIds)];
    if (q) {
      const term = `%${q}%`;
      conditions.push(
        or(like(projects.name, term), like(projects.description, term), like(projects.code, term))!,
      );
    }

    const results = await db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.name))
      .limit(20);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/projects] search failed:', err);
    return error.internal(c, 'Failed to search projects');
  }
});

// ============================================================================
// GET /:id/permissions — derive current user's role + flags for one project.
// Project manager (creator) is treated as owner even without a member row.
// ============================================================================

app.get('/:id/permissions', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  try {
    const { projects, projectMembers } = schema;
    const [[member], [project]] = await Promise.all([
      db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
            eq(projectMembers.isActive, true),
            isNull(projectMembers.deletedAt),
          ),
        )
        .limit(1),
      db
        .select({ projectManagerId: projects.projectManagerId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1),
    ]);

    const isProjectManager = !!project && project.projectManagerId === userId;
    const projectRole = (member?.role ?? '').toLowerCase() || null;
    const role = projectRole ?? (isProjectManager ? 'owner' : null);
    const isAdmin = isProjectManager || role === 'owner' || role === 'admin';
    const canWrite = isAdmin || role === 'member';
    const canRead = canWrite || role === 'viewer';

    return success(c, { role, canRead, canWrite, isAdmin });
  } catch (err) {
    console.error('[app-api/projects] permissions failed:', err);
    return error.internal(c, 'Failed to fetch project permissions');
  }
});

// ============================================================================
// GET /:id/gantt/tasks — tasks formatted for Gantt rendering.
// Registered BEFORE /:id so the sub-path literal wins.
// ============================================================================

app.get('/:id/gantt/tasks', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('id');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }

  try {
    const { tasks } = schema;

    const results = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        milestoneId: tasks.milestoneId,
        parentTaskId: tasks.parentTaskId,
        sprintId: tasks.sprintId,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        completedDate: tasks.completedDate,
        status: tasks.status,
        priority: tasks.priority,
        progress: tasks.progress,
        assigneeId: tasks.assigneeId,
        type: tasks.type,
        dependsOn: tasks.dependsOn,
        blocks: tasks.blocks,
        estimatedHours: tasks.estimatedHours,
        actualHours: tasks.actualHours,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .orderBy(tasks.startDate, tasks.dueDate);

    return success(c, results);
  } catch (err) {
    console.error('[app-api/projects] gantt/tasks failed:', err);
    return error.internal(c, 'Failed to fetch gantt tasks');
  }
});

// ============================================================================
// GET /:id/gantt/milestones — milestones formatted for Gantt rendering.
// ============================================================================

app.get('/:id/gantt/milestones', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('id');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }

  try {
    const { milestones } = schema;

    const results = await db
      .select({
        id: milestones.id,
        name: milestones.name,
        description: milestones.description,
        dueDate: milestones.dueDate,
        completedAt: milestones.completedAt,
        status: milestones.status,
        progress: milestones.progress,
        ownerId: milestones.ownerId,
        isKeyMilestone: milestones.isKeyMilestone,
        dependsOn: milestones.dependsOn,
        completedTasks: milestones.completedTasks,
        totalTasks: milestones.totalTasks,
        createdAt: milestones.createdAt,
      })
      .from(milestones)
      .where(and(eq(milestones.projectId, projectId), isNull(milestones.deletedAt)))
      .orderBy(milestones.dueDate);

    return success(c, results);
  } catch (err) {
    console.error('[app-api/projects] gantt/milestones failed:', err);
    return error.internal(c, 'Failed to fetch gantt milestones');
  }
});

// ============================================================================
// GET /:id/workload — team capacity + task distribution for one project.
// ============================================================================

app.get('/:id/workload', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('id');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }

  try {
    const { projects, projectMembers, workspaceMembers, tasks } = schema;

    // Verify project exists.
    const [project] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) return error.notFound(c, 'Project', projectId);

    // Active members with workspace user details.
    const members = await db
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        allocationPercentage: projectMembers.allocationPercentage,
        hoursPerWeek: workspaceMembers.hoursPerWeek,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        avatar: workspaceMembers.picture,
      })
      .from(projectMembers)
      .leftJoin(workspaceMembers, eq(projectMembers.userId, workspaceMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
        ),
      );

    // Active, assigned, non-terminal tasks for this project.
    const projectTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        assigneeId: tasks.assigneeId,
        status: tasks.status,
        priority: tasks.priority,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        estimatedHours: tasks.estimatedHours,
        actualHours: tasks.actualHours,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          isNull(tasks.deletedAt),
          sql`${tasks.assigneeId} is not null`,
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      );

    const totalTasks = projectTasks.length;

    // Group tasks by assignee.
    const tasksByAssignee = new Map<string, typeof projectTasks>();
    for (const task of projectTasks) {
      if (!task.assigneeId) continue;
      const existing = tasksByAssignee.get(task.assigneeId) ?? [];
      existing.push(task);
      tasksByAssignee.set(task.assigneeId, existing);
    }

    const teamMembers = members.map((m) => {
      const memberTasks = tasksByAssignee.get(m.userId) ?? [];
      const hoursPerWeek = Number(m.hoursPerWeek) || 40;
      const capacity = Math.round(((Number(m.allocationPercentage) || 100) / 100) * hoursPerWeek);
      const initials = (m.name ?? m.email ?? m.userId).slice(0, 2).toUpperCase();
      return {
        userId: m.userId,
        name: m.name ?? m.email ?? m.userId,
        email: m.email ?? '',
        avatar: m.avatar ?? '',
        initials,
        role: m.role,
        capacity,
        tasks: memberTasks.map((t) => ({
          id: t.id,
          title: t.title,
          projectId,
          projectName: project.name,
          estimatedHours: t.estimatedHours ?? 0,
          actualHours: t.actualHours ?? 0,
          priority: t.priority ?? 'medium',
          status: t.status ?? 'todo',
          startDate: t.startDate ? t.startDate.toISOString() : null,
          dueDate: t.dueDate ? t.dueDate.toISOString() : null,
        })),
      };
    });

    return success(c, {
      projectId,
      projectName: project.name,
      totalMembers: members.length,
      totalTasks,
      teamMembers,
    });
  } catch (err) {
    console.error('[app-api/projects] workload failed:', err);
    return error.internal(c, 'Failed to fetch project workload');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await canAccessProject(c, id))) {
    return error.forbidden(c, 'You are not a member of this project');
  }
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/projects] get failed:', err);
    return error.internal(c, 'Failed to fetch project');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('prj');
  const now = new Date();
  try {
    // Default the project manager to the creator so the owner-fallback in the
    // permissions endpoint resolves even if the membership row is ever missing.
    const projectManagerId = data.projectManagerId ?? userId ?? null;
    await db
      .insert(t)
      .values({ id, ...data, projectManagerId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);

    // Add the creator as an `owner` member so they can actually work in the
    // project they just created. Without this row the project is inaccessible
    // to its own creator. Best-effort: never fail project creation over it.
    if (userId) {
      try {
        const memberId = generateId('pmem');
        await db.insert(schema.projectMembers).values({
          id: memberId,
          projectId: id,
          userId,
          role: 'owner',
          isActive: true,
          joinedAt: now,
          createdAt: now,
          updatedAt: now,
        } as unknown as typeof schema.projectMembers.$inferInsert);
        publishEntityEvent({
          c,
          entityType: 'project_member',
          entityId: memberId,
          action: 'added',
          data: { id: memberId, projectId: id, userId, role: 'owner' },
        });
      } catch (memberErr) {
        console.error('[app-api/projects] failed to add creator as owner member:', memberErr);
      }
    }

    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'created',
      data: { id, name: (data as any).name },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/projects] create failed:', err);
    return error.internal(c, 'Failed to create project');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  // Row-level guard: only the project's owner/admin/manager (or scope:all) may
  // edit it — `projects:update` alone gates the feature, not the specific row.
  if (!(await canManageProject(c, id))) {
    return error.forbidden(c, 'You must be a project owner, admin, or manager to edit this project');
  }
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'updated',
      data: { id, name: (data as any).name ?? existing.name },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/projects] update failed:', err);
    return error.internal(c, 'Failed to update project');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await canManageProject(c, id))) {
    return error.forbidden(c, 'You must be a project owner, admin, or manager to delete this project');
  }
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/projects] delete failed:', err);
    return error.internal(c, 'Failed to delete project');
  }
});

// ============================================================================
// Task import jobs — async bulk import via the IMPORT_TASKS Cloudflare
// Workflow (src/workflows/import-tasks.ts, hosted in this worker under the
// `import-tasks-v2*` names). Ported from api-worker's deleted
// routes/projects/tasks.ts import-jobs surface (W4 legacy-worker phase-out);
// consumed by the platform's ImportTasksDialog at
// POST /api/projects/:projectId/tasks/import-jobs.
// ============================================================================

const importTasksSchema = z.object({
  tasks: z
    .array(z.record(z.unknown()))
    .min(1, 'No tasks to import')
    .max(50000, 'Cannot import more than 50,000 tasks at once'),
});

/**
 * POST /:projectId/tasks/import-jobs — start an async bulk import of tasks.
 *
 * Body: { tasks: [...] } — each row may include `key` to upsert an existing
 * task. Writes the payload to R2, creates a taskImportJobs row, dispatches the
 * ImportTasksWorkflow, and returns the jobId. Clients poll
 * GET /:projectId/tasks/import-jobs/:jobId for progress.
 */
app.post(
  '/:projectId/tasks/import-jobs',
  requirePermission('tasks:create'),
  zValidator('json', importTasksSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    if (!workspaceId) return error.orgRequired(c);
    if (!(await canAccessProject(c, projectId))) {
      return error.forbidden(c, 'You are not a member of this project');
    }

    const { tasks: rows } = c.req.valid('json');

    if (!c.env.STORAGE) {
      return error.internal(c, 'Storage binding not available');
    }
    if (!c.env.IMPORT_TASKS) {
      return error.internal(c, 'Import workflow binding not available');
    }

    const db = c.get('tenantDb');

    // Guard: the project must exist in this tenant.
    const [project] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, projectId), isNull(t.deletedAt)))
      .limit(1);
    if (!project) return error.notFound(c, 'Project', projectId);

    const jobId = generateId('timp');
    const r2Key = `imports/tasks/${workspaceId}/${projectId}/${jobId}.json`;

    try {
      await c.env.STORAGE.put(r2Key, JSON.stringify(rows), {
        httpMetadata: { contentType: 'application/json' },
      });

      await db.insert(schema.taskImportJobs).values({
        id: jobId,
        workspaceId,
        userId,
        projectId,
        r2Key,
        status: 'queued',
        total: rows.length,
        processed: 0,
        imported: 0,
        updated: 0,
        failed: 0,
        errors: [],
      });

      const instance = await c.env.IMPORT_TASKS.create({
        id: jobId,
        params: { jobId, workspaceId, userId, projectId, r2Key },
      });

      await db
        .update(schema.taskImportJobs)
        .set({ workflowInstanceId: instance.id, updatedAt: new Date() })
        .where(eq(schema.taskImportJobs.id, jobId));

      // NOTE: no publishEntityEvent here — the import creates up to 50k tasks
      // inside the workflow; there is no bulk-import entity type in the
      // entity-events catalog, and fanning out one event per row is not viable.
      // Shape delta vs legacy api-worker: 201 instead of 202 (app-api's
      // success() helper only allows 200/201) and `{ data: … }` instead of
      // `{ success, data }` — W5 adapts the ImportTasksDialog accordingly.
      return success(c, { jobId, total: rows.length, status: 'queued' }, 201);
    } catch (err: any) {
      console.error('[app-api/projects] failed to start task import:', err?.message || err);
      try {
        await db
          .update(schema.taskImportJobs)
          .set({
            status: 'failed',
            errorMessage: err?.message || 'Failed to start import',
            updatedAt: new Date(),
          })
          .where(eq(schema.taskImportJobs.id, jobId));
      } catch {
        // ignore — the insert itself may have been what failed
      }
      return error.internal(c, 'Failed to start import: ' + (err?.message || 'Unknown error'));
    }
  },
);

/**
 * GET /:projectId/tasks/import-jobs/:jobId — poll status of an async import.
 */
app.get(
  '/:projectId/tasks/import-jobs/:jobId',
  requirePermission('tasks:create'),
  async (c) => {
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    const projectId = c.req.param('projectId');
    const jobId = c.req.param('jobId');
    if (!workspaceId) return error.orgRequired(c);
    if (!(await canAccessProject(c, projectId))) {
      return error.forbidden(c, 'You are not a member of this project');
    }

    const db = c.get('tenantDb');

    const rows = await db
      .select()
      .from(schema.taskImportJobs)
      .where(
        and(
          eq(schema.taskImportJobs.id, jobId),
          eq(schema.taskImportJobs.workspaceId, workspaceId),
          eq(schema.taskImportJobs.projectId, projectId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return error.notFound(c, 'Import job', jobId);
    }

    const job = rows[0]!;
    return success(c, {
      jobId: job.id,
      status: job.status,
      total: job.total,
      processed: job.processed,
      imported: job.imported,
      updated: job.updated,
      failed: job.failed,
      errors: (job.errors || []).slice(0, 100),
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  },
);

export const projectsRoutes = app;

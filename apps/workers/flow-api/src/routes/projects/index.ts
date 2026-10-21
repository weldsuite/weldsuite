/**
 * Project routes — flat /api/projects/* surface backed by `projects`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createProjectSchema, updateProjectSchema, normalizeProjectStatus } from '@weldsuite/app-api-client/schemas/projects';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { schema } from '@weldsuite/worker-kit/db';
import {
  accessibleProjectIds,
  canAccessProject,
  canChangeOwners,
  canManageProject,
  canWriteProject,
  resolveProjectAccess,
} from '../../lib/project-access';
import { containsPattern } from '../../lib/ilike-pattern';
import {
  PROJECT_TIMESTAMP_FIELDS,
  PROJECT_WRITABLE_FIELDS,
  coerceTimestamps,
  pickWritable,
} from '../../lib/writable-columns';
import {
  getMilestoneStats,
  getProjectStats,
  withMilestoneStats,
  withProjectStats,
} from '@weldsuite/flow-domain/project-stats';
import {
  CustomFieldValidationError,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '@weldsuite/core-domain/custom-field-values';
import {
  PROJECT_CUSTOM_FIELD_ENTITY,
  prepareProjectCustomFields,
  writeProjectCustomFields,
  type PreparedProjectCustomFields,
} from '../../lib/project-custom-fields';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projects;

const EMPTY_WORKLOAD = {
  totalProjects: 0,
  totalMembers: 0,
  totalTasks: 0,
  teamMembers: [],
  unassigned: { tasks: [] },
};

/**
 * Membership boundary for callers without `projects:scope:all`: projects the
 * user manages (projectManagerId) or is an active member of.
 */
async function buildMembershipCondition(db: Variables['tenantDb'], userId: string): Promise<SQL> {
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
  return memberProjectIds.length
    ? or(eq(t.projectManagerId, userId), inArray(t.id, memberProjectIds))!
    : eq(t.projectManagerId, userId);
}

/**
 * The status the All Projects table shows for a row: a set `health` wins, else
 * the stored `status` (same mapping as the platform's table: on-track, at-risk,
 * off-track, on-hold, completed). The `status` list filter and sort run on this,
 * so the values the UI offers ("on-track", "at-risk", ...) match what it displays.
 */
const DERIVED_STATUS_SQL = sql`CASE
  WHEN coalesce(btrim(${t.health}), '') <> '' THEN
    CASE regexp_replace(lower(btrim(${t.health})), '[\\s-]+', '_', 'g')
      WHEN 'at_risk' THEN 'at-risk'
      WHEN 'off_track' THEN 'off-track'
      WHEN 'critical' THEN 'off-track'
      ELSE 'on-track'
    END
  ELSE
    CASE regexp_replace(lower(btrim(${t.status})), '[\\s-]+', '_', 'g')
      WHEN 'on_hold' THEN 'on-hold'
      WHEN 'completed' THEN 'completed'
      WHEN 'archived' THEN 'completed'
      WHEN 'cancelled' THEN 'off-track'
      ELSE 'on-track'
    END
END`;
const DERIVED_STATUSES = new Set(['on-track', 'at-risk', 'off-track', 'on-hold', 'completed']);

/** Priority rank for sorting; an unset priority shows (and sorts) as "medium". */
const PRIORITY_RANK_SQL = sql`CASE lower(coalesce(nullif(btrim(${t.priority}), ''), 'medium'))
  WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
END`;

const pm = schema.projectMembers;
const wm = schema.workspaceMembers;

/** Name of the project's owner member (first owner row), falling back to nothing. */
const OWNER_NAME_SQL = sql`(
  SELECT ${wm.name} FROM ${pm}
  JOIN ${wm} ON ${wm.userId} = ${pm.userId}
  WHERE ${pm.projectId} = ${t.id} AND lower(${pm.role}) = 'owner'
    AND ${pm.isActive} = true AND ${pm.deletedAt} IS NULL
  ORDER BY ${pm.createdAt} ASC LIMIT 1
)`;

/** ownerId matches the project manager or an active owner member. */
function ownerCondition(ownerId: string): SQL {
  return or(
    eq(t.projectManagerId, ownerId),
    sql`EXISTS (
      SELECT 1 FROM ${pm}
      WHERE ${pm.projectId} = ${t.id} AND ${pm.userId} = ${ownerId} AND lower(${pm.role}) = 'owner'
        AND ${pm.isActive} = true AND ${pm.deletedAt} IS NULL
    )`,
  )!;
}

const isPresent = (value: string | undefined): value is string => value !== undefined && value !== '';

/** Condition for the `status` list filter: a derived status, or a stored one. */
function statusCondition(status: string): SQL {
  if (DERIVED_STATUSES.has(status)) return sql`${DERIVED_STATUS_SQL} = ${status}`;
  // Rows written before statuses were normalised may be lowercase or snake_case
  // ("planning", "on_hold"), so compare on a spelling-insensitive key.
  const key = normalizeProjectStatus(status).toLowerCase().replace(/[\s_-]+/g, '');
  return sql`lower(regexp_replace(${t.status}, '[\\s_-]+', '', 'g')) = ${key}`;
}

/** Condition for the `priority` list filter; an unset priority counts as "medium". */
function priorityCondition(value: string): SQL {
  const priority = value.trim().toLowerCase();
  return priority === 'medium'
    ? sql`lower(coalesce(nullif(btrim(${t.priority}), ''), 'medium')) = 'medium'`
    : sql`lower(btrim(${t.priority})) = ${priority}`;
}

/** Filters derived from the list query string. */
function buildProjectFilters(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [];
  if (isPresent(q.status)) conditions.push(statusCondition(q.status));
  if (isPresent(q.priority)) conditions.push(priorityCondition(q.priority));
  if (isPresent(q.ownerId)) conditions.push(ownerCondition(q.ownerId));
  if (isPresent(q.customerId)) conditions.push(eq(t.customerId, q.customerId));
  if (isPresent(q.isActive)) {
    // Accept the truthy strings the WeldFlow UI sends (`?isActive=true`).
    conditions.push(eq(t.isActive, q.isActive === 'true' || q.isActive === '1'));
  }
  if (q.search) {
    conditions.push(or(ilike(t.name, containsPattern(q.search)), ilike(t.code, containsPattern(q.search)))!);
  }
  return conditions;
}

const SORT_EXPRESSIONS: Record<string, SQL> = {
  name: sql`lower(${t.name})`,
  status: DERIVED_STATUS_SQL,
  priority: PRIORITY_RANK_SQL,
  dueDate: sql`${t.endDate}`,
  owner: sql`lower(${OWNER_NAME_SQL})`,
  createdAt: sql`${t.createdAt}`,
};

/**
 * ORDER BY for an explicit `sortField` / `sortDirection`, or null for the default
 * newest-first keyset order. Sorted lists page by offset (cursor `o:<n>`), since
 * a keyset cursor only works for the default order.
 */
function buildProjectOrder(q: Record<string, string>): SQL[] | null {
  const expression = q.sortField ? SORT_EXPRESSIONS[q.sortField] : undefined;
  if (!expression) return null;
  const direction = q.sortDirection === 'asc' ? 'asc' : 'desc';
  if (q.sortField === 'createdAt' && direction === 'desc') return null;
  return [
    sql`${expression} ${sql.raw(direction)} NULLS LAST`,
    direction === 'asc' ? asc(t.createdAt) : desc(t.createdAt),
    direction === 'asc' ? asc(t.id) : desc(t.id),
  ];
}

const OFFSET_CURSOR = /^o:(\d+)$/;

/** Keyset condition for the row after `cursor`, or undefined when the cursor row is unknown. */
async function buildProjectCursorCondition(
  db: Variables['tenantDb'],
  cursor: string,
): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursor)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

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
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const canSeeAll = await hasContextPermission(c, 'projects:scope:all');

  const filterConditions: SQL[] = [isNull(t.deletedAt)];
  if (!canSeeAll) filterConditions.push(await buildMembershipCondition(db, userId));
  filterConditions.push(...buildProjectFilters(q));
  const countWhere = and(...filterConditions);

  // Default order: newest first, keyset cursor. An explicit sort pages by offset.
  const order = buildProjectOrder(q);
  const offset = order ? Number(OFFSET_CURSOR.exec(q.cursor ?? '')?.[1] ?? 0) : 0;
  const conditions = [...filterConditions];
  if (!order && q.cursor) {
    const cursorCondition = await buildProjectCursorCondition(db, q.cursor);
    if (cursorCondition) conditions.push(cursorCondition);
  }
  const where = and(...conditions);

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(...(order ?? [desc(t.createdAt), desc(t.id)]))
        .limit(limit + 1)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) nextCursor = order ? `o:${offset + limit}` : data[data.length - 1].id;
    const totalCount = Number(countRes[0]?.count ?? 0);
    const [stats, hydrated] = await Promise.all([
      getProjectStats(db, data.map((p) => p.id)),
      hydrateCustomFields(db, PROJECT_CUSTOM_FIELD_ENTITY, data),
    ]);
    return list(c, withProjectStats(hydrated, stats), cursorPagination(totalCount, hasMore, nextCursor));
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

    // Live projects the caller may access: everything for scope:all holders,
    // otherwise the ones they manage or belong to. Soft-deleted projects never count.
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null && accessible.length === 0) return success(c, EMPTY_WORKLOAD);
    const projectList = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(isNull(projects.deletedAt), accessible === null ? undefined : inArray(projects.id, accessible)));
    const userProjectIds = projectList.map((p) => p.id);
    if (userProjectIds.length === 0) return success(c, EMPTY_WORKLOAD);
    const projectNameMap = new Map(projectList.map((p) => [p.id, p.name]));

    // All active members across those projects with workspace user details.
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

    // One row per person across projects: the first row's profile and role, and
    // the allocations summed (a missing allocation counts as 100%), capped at 100%.
    const uniqueMembers = new Map<string, (typeof members)[0] & { allocation: number }>();
    for (const m of members) {
      const allocation = Number(m.allocationPercentage) || 100;
      const seen = uniqueMembers.get(m.userId);
      if (seen) seen.allocation += allocation;
      else uniqueMembers.set(m.userId, { ...m, allocation });
    }

    // Active, non-terminal tasks across all those projects (assigned or not).
    const projectTasks = await db
      .select({
        id: tasks.id,
        number: tasks.number,
        key: tasks.key,
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
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      );

    const toTaskRow = (t: (typeof projectTasks)[0]) => ({
      id: t.id,
      number: t.number,
      key: t.key,
      title: t.title,
      projectId: t.projectId,
      projectName: projectNameMap.get(t.projectId ?? '') ?? '',
      estimatedHours: t.estimatedHours ?? 0,
      actualHours: t.actualHours ?? 0,
      priority: t.priority ?? 'medium',
      status: t.status ?? 'todo',
      startDate: t.startDate ? t.startDate.toISOString() : null,
      dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    });

    // Group tasks by assignee; tasks nobody on these projects carries go to the
    // "unassigned / other" bucket so the totals add up.
    const tasksByAssignee = new Map<string, typeof projectTasks>();
    const otherTasks: typeof projectTasks = [];
    for (const task of projectTasks) {
      if (!task.assigneeId || !uniqueMembers.has(task.assigneeId)) {
        otherTasks.push(task);
        continue;
      }
      const existing = tasksByAssignee.get(task.assigneeId) ?? [];
      existing.push(task);
      tasksByAssignee.set(task.assigneeId, existing);
    }

    const teamMembers = Array.from(uniqueMembers.values()).map((m) => {
      const memberTasks = tasksByAssignee.get(m.userId) ?? [];
      const hoursPerWeek = Number(m.hoursPerWeek) || 40;
      const capacity = Math.round((Math.min(m.allocation, 100) / 100) * hoursPerWeek);
      const initials = (m.name ?? m.email ?? m.userId).slice(0, 2).toUpperCase();
      return {
        userId: m.userId,
        name: m.name ?? m.email ?? m.userId,
        email: m.email ?? '',
        avatar: m.avatar ?? '',
        initials,
        role: m.role,
        capacity,
        tasks: memberTasks.map(toTaskRow),
      };
    });

    return success(c, {
      totalProjects: userProjectIds.length,
      totalMembers: uniqueMembers.size,
      totalTasks: projectTasks.length,
      teamMembers,
      unassigned: { tasks: otherTasks.map(toTaskRow) },
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
    const { projects } = schema;
    // Projects the caller may access (everything for scope:all holders).
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null && accessible.length === 0) return success(c, []);

    const conditions: SQL[] = [isNull(projects.deletedAt)];
    if (accessible !== null) conditions.push(inArray(projects.id, accessible));
    if (q) {
      const term = containsPattern(q);
      conditions.push(
        or(ilike(projects.name, term), ilike(projects.description, term), ilike(projects.code, term))!,
      );
    }

    const results = await db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.name))
      .limit(20);
    const stats = await getProjectStats(db, results.map((p) => p.id));
    return success(c, withProjectStats(results, stats));
  } catch (err) {
    console.error('[app-api/projects] search failed:', err);
    return error.internal(c, 'Failed to search projects');
  }
});

// ============================================================================
// GET /:id/permissions — derive current user's role + flags for one project.
// Project manager (creator) is treated as owner even without a member row.
// Workspace owners/admins (`projects:scope:all`) get full rights on every
// project. Same rule as the write guards (resolveProjectAccess); viewers get
// canWrite: false and the API rejects their mutations with 403.
// ============================================================================

app.get('/:id/permissions', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  try {
    const { role, canRead, canWrite, isAdmin } = await resolveProjectAccess(c, projectId);
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

    const stats = await getMilestoneStats(db, results);
    return success(c, withMilestoneStats(results, stats));
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
    const [stats, hydrated] = await Promise.all([
      getProjectStats(db, [row.id]),
      hydrateCustomFieldsOne(db, PROJECT_CUSTOM_FIELD_ENTITY, row),
    ]);
    return success(c, withProjectStats([hydrated ?? row], stats)[0]);
  } catch (err) {
    console.error('[app-api/projects] get failed:', err);
    return error.internal(c, 'Failed to fetch project');
  }
});

/** Validate the body's customFields up front; a bad value answers 400 before any write. */
async function prepareCustomFieldsOrError(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  customFields: Record<string, unknown> | null | undefined,
): Promise<PreparedProjectCustomFields | null | Response> {
  try {
    return await prepareProjectCustomFields(c.get('tenantDb'), customFields);
  } catch (err) {
    if (err instanceof CustomFieldValidationError) return error.badRequest(c, err.message);
    throw err;
  }
}

app.post('/', requirePermission('projects:create'), zValidator('json', createProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = c.req.valid('json');
  // Allow-listed columns only (the schema is passthrough, the DB row is not), with
  // date strings coerced to Date so the timestamp columns bind.
  const writable = coerceTimestamps(
    pickWritable(body as Record<string, unknown>, PROJECT_WRITABLE_FIELDS),
    PROJECT_TIMESTAMP_FIELDS,
  );
  if (!writable.ok) return error.badRequest(c, `Invalid date: ${writable.field}`);
  const data = writable.values;
  const id = generateId('prj');
  const now = new Date();
  try {
    const customFields = await prepareCustomFieldsOrError(c, body.customFields);
    if (customFields instanceof Response) return customFields;

    // Default the project manager to the creator so the owner-fallback in the
    // permissions endpoint resolves even if the membership row is ever missing.
    const projectManagerId = (data.projectManagerId as string | null | undefined) ?? userId ?? null;
    await db
      .insert(t)
      .values({ ...data, id, projectManagerId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    if (customFields) await writeProjectCustomFields(db, id, customFields);

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

    const [createdRow] = await db.select().from(t).where(eq(t.id, id)).limit(1);

    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'created',
      data: projectAnalyticsPayload((createdRow ?? { id, ...data }) as Record<string, unknown>),
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
  // Row-level guard: only the project's owner/admin/manager (or scope:all) may
  // edit it — `projects:update` alone gates the feature, not the specific row.
  if (!(await canManageProject(c, id))) {
    return error.forbidden(c, 'You must be a project owner, admin, or manager to edit this project');
  }
  const body = c.req.valid('json');
  const writable = coerceTimestamps(
    pickWritable(body as Record<string, unknown>, PROJECT_WRITABLE_FIELDS),
    PROJECT_TIMESTAMP_FIELDS,
  );
  if (!writable.ok) return error.badRequest(c, `Invalid date: ${writable.field}`);
  const data = writable.values;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project', id);
    const customFields = await prepareCustomFieldsOrError(c, body.customFields);
    if (customFields instanceof Response) return customFields;
    // The project manager resolves to the owner role, so handing the seat to someone
    // else (or taking it) is an owner-level change, same rule as granting owner.
    const nextManagerId = data.projectManagerId as string | null | undefined;
    if (nextManagerId !== undefined && nextManagerId !== existing.projectManagerId && !(await canChangeOwners(c, id))) {
      return error.forbidden(c, 'Only a project owner can change the project manager');
    }
    const update = { ...data, updatedAt: new Date() } as Partial<typeof t.$inferInsert>;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    if (customFields) await writeProjectCustomFields(db, id, customFields);
    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'updated',
      data: projectAnalyticsPayload(
        { ...(existing as Record<string, unknown>), ...(data as Record<string, unknown>), id },
      ),
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/projects] update failed:', err);
    return error.internal(c, 'Failed to update project');
  }
});

/**
 * Plans handing every live task of `sourceId` to `destId`. A task keeps its
 * status when the destination has a stage for it (the first one by position),
 * otherwise it lands in the destination's first stage. Project-scoped
 * references (sprint, milestone, key, board position) are cleared, as in
 * POST /api/tasks/:id/move; parent links stay, since the whole tree moves.
 * Positions are offset past the destination's last task, keeping their order.
 */
async function planTaskTransfer(db: Variables['tenantDb'], sourceId: string, destId: string, now: Date) {
  const tasks = schema.tasks;
  const stages = schema.projectPipelineStages;
  const moving = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.projectId, sourceId), isNull(tasks.deletedAt)));
  const destStages = await db
    .select({ id: stages.id, systemStatus: stages.systemStatus })
    .from(stages)
    .where(and(eq(stages.projectId, destId), isNull(stages.deletedAt)))
    .orderBy(asc(stages.position));
  const stageByStatus = new Map<string, string>();
  for (const stage of destStages) {
    if (!stageByStatus.has(stage.systemStatus)) stageByStatus.set(stage.systemStatus, stage.id);
  }
  const fallback = { stageId: destStages[0]?.id ?? null, status: destStages[0]?.systemStatus ?? 'todo' };
  const [positionRow] = await db
    .select({ maxPosition: sql<number>`coalesce(max(${tasks.position}), 0)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, destId), isNull(tasks.deletedAt)));
  const offset = (positionRow?.maxPosition || 0) + 1;

  const reset = {
    projectId: destId,
    sprintId: null,
    milestoneId: null,
    key: null,
    boardPosition: null,
    position: sql`${tasks.position} + ${offset}`,
    updatedAt: now,
  };
  const keptStatuses = [...new Set(moving.map((row) => row.status))].filter((status) => stageByStatus.has(status));
  const stillInSource = and(eq(tasks.projectId, sourceId), isNull(tasks.deletedAt));

  return {
    moved: moving.map((row) => ({
      id: row.id,
      title: row.title,
      status: stageByStatus.has(row.status) ? row.status : fallback.status,
    })),
    // One update per kept status, then one for the rest: each moves its rows out
    // of the source project, so the last one only sees what no stage matched.
    build: (handle: Variables['tenantDb']) => [
      ...keptStatuses.map((status) =>
        handle
          .update(tasks)
          .set({ ...reset, stageId: stageByStatus.get(status) })
          .where(and(stillInSource, eq(tasks.status, status))),
      ),
      handle.update(tasks).set({ ...reset, ...fallback }).where(stillInSource),
    ],
  };
}

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // Optional: hand the project's tasks to another project before it goes.
  const moveTasksTo = c.req.query('moveTasksTo') || undefined;
  if (!(await canManageProject(c, id))) {
    return error.forbidden(c, 'You must be a project owner, admin, or manager to delete this project');
  }
  if (moveTasksTo === id) return error.badRequest(c, 'Cannot move tasks into the project being deleted');
  if (moveTasksTo && !(await canWriteProject(c, moveTasksTo))) {
    return error.forbidden(c, 'You do not have write access to the destination project');
  }
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project', id);
    const now = new Date();
    const softDelete = (handle: Variables['tenantDb']) =>
      handle.update(t).set({ deletedAt: now, updatedAt: now }).where(eq(t.id, id));

    let moved: { id: string; title: string; status: string }[] = [];
    if (moveTasksTo) {
      const [destProject] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.id, moveTasksTo), isNull(t.deletedAt)))
        .limit(1);
      if (!destProject) return error.notFound(c, 'Project', moveTasksTo);
      const transfer = await planTaskTransfer(db, id, moveTasksTo, now);
      moved = transfer.moved;
      // All-or-nothing: the tasks never end up half moved out of a live project.
      await atomically(db, (handle) => [...transfer.build(handle), softDelete(handle)]);
    } else {
      await softDelete(db);
    }

    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });
    for (const row of moved) {
      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: row.id,
        action: 'updated',
        data: { id: row.id, title: row.title, projectId: moveTasksTo, status: row.status },
      });
    }
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
    if (!(await canWriteProject(c, projectId))) {
      return error.forbidden(c, 'You do not have write access to this project');
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

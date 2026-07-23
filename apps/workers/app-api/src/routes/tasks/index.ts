/**
 * Task routes — flat /api/tasks/* surface backed by `tasks`.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 *
 * Create endpoints:
 *   POST /api/tasks                       — global create (My Tasks, cross-project)
 *   POST /api/tasks/projects/:projectId   — project-scoped create (WeldFlow)
 *
 * List / filter features ported from api-worker tasks.ts:
 *   - dueDateBucket (today / this-week / overdue / later / no-date)
 *   - sortField + sortDirection
 *   - tags / labels (CSV or array)
 *   - myTasks shorthand (assigneeId = current user)
 *   - includeSubtasks (attach full descendant tree)
 *   - enrichment (assignee display fields + scheduled calendar slot)
 *
 * Additional endpoints:
 *   PATCH /api/tasks/reorder              — batch reorder (registered BEFORE /:id)
 *   PATCH /api/tasks/:id/toggle           — done ↔ todo toggle with recurrence
 *   PATCH /api/tasks/:id/position         — kanban drag & drop
 *   PATCH /api/tasks/:id/status           — status-only update
 *   GET   /api/tasks/:id/subtasks         — list direct children
 *   PUT   /api/tasks/:id/dependencies     — update dependsOn / blocks with reciprocal sync
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { sendTaskAssignmentNotification } from '@weldsuite/notifications';
import {
  createCalendarEventForTask,
  rescheduleCalendarEvent,
  cancelCalendarEvent,
  confirmCalendarEvent,
  deleteCalendarEvent,
  fetchTaskScheduledSlots,
} from '@weldsuite/db/lib/calendar-sync';
import { createTaskSchema, updateTaskSchema, moveTaskSchema } from '@weldsuite/app-api-client/schemas/tasks';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '../../services/custom-field-values';
import { getMasterDb, masterSchema, schema } from '../../db';
import { createFile } from '../../services/files';
import { accessibleProjectIds, canAccessProject, canAccessTaskProject } from '../../lib/project-access';
import { allocateTaskNumber } from '../../services/task-numbering';

// ============================================================================
// Constants
// ============================================================================

const MAX_SUBTASK_DEPTH = 10;

// ============================================================================
// Filter helpers (ported from api-worker tasks.ts)
// ============================================================================

export type DueDateBucket = 'overdue' | 'today' | 'this-week' | 'later' | 'no-date';

export const dueDateBucketEnum = z
  .enum(['overdue', 'today', 'this-week', 'later', 'no-date'])
  .optional();

export const taskSortFieldEnum = z
  .enum(['title', 'status', 'priority', 'dueDate', 'assignee', 'position', 'createdAt'])
  .optional()
  .default('position');

export const taskCsvStringArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    const arr = Array.isArray(val) ? val : val.split(',');
    const cleaned = arr.map((s) => s.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  });

/**
 * Translate a UI bucket name into the (lo, hi] window for `tasks.dueDate`.
 * Server-side time is UTC.
 */
export function dueDateBucketCondition(bucket: DueDateBucket, dueDateColumn: any) {
  const now = new Date();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const dayOfWeek = startOfTomorrow.getUTCDay();
  const daysUntilNextMonday = ((1 - dayOfWeek + 7) % 7) || 7;
  const startOfNextWeek = new Date(
    startOfTomorrow.getTime() + daysUntilNextMonday * 24 * 60 * 60 * 1000,
  );

  switch (bucket) {
    case 'overdue':
      return and(lt(dueDateColumn, startOfToday), sql`${dueDateColumn} IS NOT NULL`)!;
    case 'today':
      return and(gte(dueDateColumn, startOfToday), lt(dueDateColumn, startOfTomorrow))!;
    case 'this-week':
      return and(gte(dueDateColumn, startOfTomorrow), lt(dueDateColumn, startOfNextWeek))!;
    case 'later':
      return gte(dueDateColumn, startOfNextWeek);
    case 'no-date':
      return isNull(dueDateColumn);
  }
}

/** Sort column whitelist for task list endpoints. */
export function resolveTaskSortColumn(field: string, tasksTable: typeof schema.tasks) {
  switch (field) {
    case 'title':
      return tasksTable.title;
    case 'status':
      return tasksTable.status;
    case 'priority':
      return tasksTable.priority;
    case 'dueDate':
      return tasksTable.dueDate;
    case 'assignee':
      return tasksTable.assigneeId;
    case 'createdAt':
      return tasksTable.createdAt;
    case 'position':
    default:
      return tasksTable.position;
  }
}

// ============================================================================
// Enrichment helpers
// ============================================================================

/**
 * Enrich task rows with assignee info from workspaceMembers and the
 * currently-scheduled calendar slot (if any).
 */
export async function enrichTasksWithAssignees(db: any, taskResults: any[]) {
  if (taskResults.length === 0) return taskResults;

  const allIds = new Set<string>();
  for (const t of taskResults) {
    if (t.assigneeId) allIds.add(t.assigneeId);
    if (Array.isArray(t.assigneeIds)) {
      for (const id of t.assigneeIds) allIds.add(id);
    }
  }

  const { workspaceMembers } = schema;
  const memberMap = new Map<string, any>();
  if (allIds.size > 0) {
    const members = await db
      .select({
        userId: workspaceMembers.userId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        avatar: workspaceMembers.picture,
      })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.userId, [...allIds]));
    for (const m of members) memberMap.set(m.userId, m);
  }

  const taskIds = taskResults
    .map((t: any) => t.id)
    .filter((id: any): id is string => typeof id === 'string');
  const eventMap = await fetchTaskScheduledSlots(db, taskIds);

  return taskResults.map((task: any) => {
    const ids: string[] =
      Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0
        ? task.assigneeIds
        : task.assigneeId
          ? [task.assigneeId]
          : [];

    const assigneesArr = ids
      .map((id: string) => memberMap.get(id))
      .filter(Boolean)
      .map((a: any) => ({ id: a.userId, name: a.name, email: a.email, avatar: a.avatar }));

    const assignee = assigneesArr.length > 0 ? assigneesArr[0] : null;
    const scheduled = eventMap.get(task.id);

    return {
      ...task,
      assignee,
      assignees: assigneesArr,
      scheduledStart: scheduled?.startTime ?? null,
      scheduledEnd: scheduled?.endTime ?? null,
      autoScheduled: scheduled?.autoScheduled ?? null,
    };
  });
}

// ============================================================================
// Recurring task helpers
// ============================================================================

function calculateNextDueDate(
  currentDueDate: Date | null,
  repeat: { frequency: string; interval?: number; unit?: string },
): Date {
  const base = currentDueDate ? new Date(currentDueDate) : new Date();

  switch (repeat.frequency) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      break;
    case 'weekly':
      base.setDate(base.getDate() + 7);
      break;
    case 'biweekly':
      base.setDate(base.getDate() + 14);
      break;
    case 'monthly':
      base.setMonth(base.getMonth() + 1);
      break;
    case 'yearly':
      base.setFullYear(base.getFullYear() + 1);
      break;
    case 'custom': {
      const interval = repeat.interval || 1;
      const unit = repeat.unit || 'days';
      switch (unit) {
        case 'days':
          base.setDate(base.getDate() + interval);
          break;
        case 'weeks':
          base.setDate(base.getDate() + interval * 7);
          break;
        case 'months':
          base.setMonth(base.getMonth() + interval);
          break;
        case 'years':
          base.setFullYear(base.getFullYear() + interval);
          break;
      }
      break;
    }
  }

  return base;
}

/**
 * Create the next occurrence of a recurring task when the current one is
 * completed. Returns the new task ID or null if the task has no repeat config.
 */
async function createNextRecurringTask(
  db: any,
  completedTask: any,
  projectId: string,
): Promise<string | null> {
  const repeat = completedTask.repeat;
  if (!repeat) return null;

  const { tasks } = schema;
  const id = generateId('task');
  const now = new Date();

  const nextDueDate = calculateNextDueDate(completedTask.dueDate, repeat);

  let nextStartDate: Date | undefined;
  if (completedTask.startDate && completedTask.dueDate) {
    const duration =
      new Date(completedTask.dueDate).getTime() - new Date(completedTask.startDate).getTime();
    nextStartDate = new Date(nextDueDate.getTime() - duration);
  }

  const positionResult = await db
    .select({ maxPosition: sql<number>`coalesce(max(${tasks.position}), 0)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
  const nextPosition = (positionResult[0]?.maxPosition || 0) + 1;
  const number = await allocateTaskNumber(db);

  await db.insert(tasks).values({
    id,
    number,
    projectId,
    title: completedTask.title,
    description: completedTask.description,
    status: 'todo',
    priority: completedTask.priority || 'medium',
    type: completedTask.type || 'task',
    assigneeId: completedTask.assigneeId,
    assigneeIds: completedTask.assigneeIds,
    reporterId: completedTask.reporterId,
    milestoneId: completedTask.milestoneId,
    startDate: nextStartDate,
    dueDate: nextDueDate,
    estimatedHours: completedTask.estimatedHours,
    duration: completedTask.duration,
    storyPoints: completedTask.storyPoints,
    tags: completedTask.tags,
    labels: completedTask.labels,
    isBillable: completedTask.isBillable,
    repeat,
    customFields: completedTask.customFields,
    position: nextPosition,
    progress: '0',
    createdAt: now,
    updatedAt: now,
  });

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'task', id, completedTask.customFields);

  return id;
}

// ============================================================================
// Dependency cycle detection
// ============================================================================

async function detectCycle(db: any, taskId: string, newDependsOn: string[]): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [...newDependsOn];
  const { tasks } = schema;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const [task] = await db
      .select({ dependsOn: tasks.dependsOn })
      .from(tasks)
      .where(eq(tasks.id, current))
      .limit(1);
    if (task?.dependsOn) queue.push(...task.dependsOn);
  }
  return false;
}

// ============================================================================
// Insert helper (shared by both POST endpoints)
// ============================================================================

const t = schema.tasks;

// Row-level WeldFlow guard messages. `tasks:*` gates the feature; acting on a
// task that belongs to a project requires membership of that project.
const TASK_PROJECT_DENIED = "You are not a member of this task's project";
const PROJECT_MEMBER_DENIED = 'You are not a member of this project';

async function insertTask(
  db: Variables['tenantDb'],
  data: Record<string, any>,
  opts: { projectId?: string | null; userId: string },
) {
  const projectId = opts.projectId ?? data.projectId ?? null;
  const id = generateId('task');
  const now = new Date();
  const number = await allocateTaskNumber(db);

  let resolvedStatus: string = data.status ?? 'todo';
  if (data.stageId) {
    const [stage] = await db
      .select({ systemStatus: schema.projectPipelineStages.systemStatus })
      .from(schema.projectPipelineStages)
      .where(eq(schema.projectPipelineStages.id, data.stageId))
      .limit(1);
    if (stage?.systemStatus) resolvedStatus = stage.systemStatus;
  }

  const positionWhere = projectId
    ? and(eq(t.projectId, projectId), isNull(t.deletedAt))
    : isNull(t.deletedAt);
  const positionResult = await db
    .select({ maxPosition: sql<number>`coalesce(max(${t.position}), 0)::int` })
    .from(t)
    .where(positionWhere);
  const nextPosition = (positionResult[0]?.maxPosition || 0) + 1;

  const assigneeIds: string[] =
    Array.isArray(data.assigneeIds) && data.assigneeIds.length > 0
      ? data.assigneeIds
      : data.assigneeId
        ? [data.assigneeId]
        : [];
  const primaryAssigneeId = assigneeIds[0] ?? null;

  await db.insert(t).values({
    id,
    number,
    projectId,
    title: data.title,
    description: data.description,
    status: resolvedStatus,
    stageId: data.stageId,
    priority: data.priority ?? 'medium',
    type: data.type ?? 'task',
    assigneeId: primaryAssigneeId,
    assigneeIds: assigneeIds.length > 0 ? assigneeIds : null,
    reporterId: data.reporterId || opts.userId,
    sprintId: data.sprintId,
    milestoneId: data.milestoneId,
    parentTaskId: data.parentTaskId,
    startDate: data.startDate ? new Date(data.startDate) : undefined,
    dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
    estimatedHours: data.estimatedHours,
    duration: data.duration,
    storyPoints: data.storyPoints,
    tags: data.tags,
    labels: data.labels,
    isBillable: data.isBillable ?? true,
    customerId: data.customerId ?? null,
    contactId: data.contactId ?? null,
    customFields: data.customFields,
    dependsOn: data.dependsOn,
    blocks: data.blocks,
    repeat: data.repeat ?? null,
    position: nextPosition,
    progress: '0',
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof t.$inferInsert);

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'task', id, data.customFields);

  const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return { row: created ?? { id }, assigneeIds };
}

// ============================================================================
// Assignment notification dispatcher
// ============================================================================

function dispatchAssignmentNotifications(
  c: {
    env: Env;
    executionCtx: ExecutionContext;
    get: (k: 'tenantDb' | 'userId' | 'workspaceId') => any;
  },
  opts: {
    assigneeIds: string[];
    taskId: string;
    taskTitle: string;
    projectId: string | null;
    taskPriority?: string | null;
    dueDate?: Date | string | null;
    taskDescription?: string | null;
  },
): void {
  if (opts.assigneeIds.length === 0) return;

  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  const category: 'projects' | 'crm' = opts.projectId ? 'projects' : 'crm';
  const actionUrl = opts.projectId
    ? `/weldflow/project/${opts.projectId}/tasks`
    : `/weldcrm/tasks`;

  const enrichment = (async () => {
    const [projectName, workspaceName] = await Promise.all([
      opts.projectId
        ? db
            .select({ name: schema.projects.name })
            .from(schema.projects)
            .where(eq(schema.projects.id, opts.projectId))
            .limit(1)
            .then((rows: { name: string | null }[]) => rows[0]?.name ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      (async () => {
        try {
          const masterDb = getMasterDb(c.env);
          const [row] = await masterDb
            .select({ name: masterSchema.workspaces.name })
            .from(masterSchema.workspaces)
            .where(eq(masterSchema.workspaces.clerkOrgId, workspaceId))
            .limit(1);
          return row?.name ?? null;
        } catch {
          return null;
        }
      })(),
    ]);
    return { projectName, workspaceName };
  })();

  for (const assigneeId of opts.assigneeIds) {
    c.executionCtx.waitUntil(
      enrichment
        .then(({ projectName, workspaceName }) =>
          sendTaskAssignmentNotification({
            db,
            env: c.env,
            workspaceId,
            assigneeId,
            assignedByUserId: userId,
            taskId: opts.taskId,
            taskTitle: opts.taskTitle,
            category,
            actionUrl,
            projectName,
            taskPriority: opts.taskPriority ?? null,
            dueDate: opts.dueDate ?? null,
            taskDescription: opts.taskDescription ?? null,
            workspaceName,
          }),
        )
        .catch((err) =>
          console.error('[app-api/tasks] assignment notification failed:', err),
        ),
    );
  }
}

// ============================================================================
// GitHub outbound-sync dispatcher
// ============================================================================

type GithubOutboundKind = 'create' | 'update' | 'status' | 'delete';

/**
 * Fire-and-forget push of a task mutation to its linked GitHub Project
 * (`GithubProjectOutboundSyncWorkflow`, hosted in integration-webhook-worker,
 * bound here via `script_name`).
 *
 * Cheap gate: dispatch only when the task's project has an active,
 * outbound-capable `githubProjectLinks` row (syncIssues, direction ≠ inbound).
 * The workflow resolves the link from `task.projectId` itself and re-checks
 * direction + connection. Inbound sync writes go straight to the tenant DB
 * (never through this route), so this never echoes an inbound change to GitHub.
 *
 * `kinds`: `create` opens an issue + adds it to the board; `update` pushes
 * title/body; `status` sets the mapped Status column + opens/closes the issue;
 * `delete` closes as not_planned. Each (task,kind) is debounced in a 15s bucket.
 */
function dispatchGithubOutboundSync(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  opts: {
    taskId: string;
    projectId: string | null | undefined;
    kinds: GithubOutboundKind[];
  },
): void {
  if (!c.env.GITHUB_PROJECT_OUTBOUND) return;
  if (!opts.projectId || opts.kinds.length === 0) return;

  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return;
  const projectId = opts.projectId;
  const binding = c.env.GITHUB_PROJECT_OUTBOUND;

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const [link] = await db
          .select({
            id: schema.githubProjectLinks.id,
            syncDirection: schema.githubProjectLinks.syncDirection,
          })
          .from(schema.githubProjectLinks)
          .where(
            and(
              eq(schema.githubProjectLinks.projectId, projectId),
              eq(schema.githubProjectLinks.syncIssues, true),
              isNull(schema.githubProjectLinks.deletedAt),
            ),
          )
          .limit(1);
        if (!link || link.syncDirection === 'inbound') return;

        const bucket = Math.floor(Date.now() / 15000);
        for (const kind of opts.kinds) {
          try {
            await binding.create({
              id: `github-outbound-${opts.taskId}-${kind}-${bucket}`,
              params: { workspaceId, taskId: opts.taskId, kind },
            });
          } catch {
            // Duplicate within the debounce window — already dispatched.
          }
        }
      } catch (err) {
        console.error('[app-api/tasks] github outbound dispatch failed:', err);
      }
    })(),
  );
}

// ============================================================================
// Router
// ============================================================================

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET / — List tasks with full filter support
// ============================================================================

const listQuerySchema = z.object({
  // Pagination (cursor)
  limit: z.coerce.number().min(1).max(200).default(50),
  cursor: z.string().optional(),
  // Legacy offset pagination (kept for WeldFlow project-scoped views)
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(200).default(50),
  // Scope
  projectId: z.string().optional(),
  sprintId: z.string().optional(),
  milestoneId: z.string().optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  personId: z.string().optional(),
  // When true, restrict to CRM-linked tasks (a company/person/contact is set),
  // excluding project tasks and fully-unlinked standalone tasks.
  crmLinked: z.coerce.boolean().optional(),
  parentTaskId: z.string().optional(),
  // Filters
  status: z.string().optional(),
  priority: z.string().optional(),
  type: z.string().optional(),
  assigneeId: z.string().optional(),
  myTasks: z.coerce.boolean().optional(),
  search: z.string().optional(),
  labelIds: taskCsvStringArray,
  tags: taskCsvStringArray,
  dueDateBucket: dueDateBucketEnum,
  dueDateFrom: z.string().optional(),
  dueDateTo: z.string().optional(),
  // Sort
  sortField: taskSortFieldEnum,
  sortDirection: z.enum(['asc', 'desc']).optional().default('asc'),
  // Subtree
  includeSubtasks: z.coerce.boolean().optional().default(false),
  // Enrichment
  enrich: z.coerce.boolean().optional().default(true),
});

app.get('/', requirePermission('tasks:read'), zValidator('query', listQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');

  const conditions: any[] = [isNull(t.deletedAt)];

  // Scope filters
  if (q.projectId) conditions.push(eq(t.projectId, q.projectId));
  // Row-level: a projectId filter must name a project the caller can access;
  // with none, limit project tasks to accessible projects.
  // KNOWN-DEFERRED: non-project tasks (null projectId — personal WeldConnect +
  // CRM-linked) are NOT owner-scoped here. `tasks:*` is a flat workspace grant
  // with no `tasks:scope:all`, and there is no per-user (assignee/creator) gate
  // yet, so a `tasks:read` holder can still see another user's personal task.
  // Gating this needs a product decision (assignee/creator vs CRM-shared) —
  // tracked as a deferred item alongside the MEDIUM findings.
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_MEMBER_DENIED);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) {
      conditions.push(or(isNull(t.projectId), inArray(t.projectId, accessible.length ? accessible : [''])));
    }
  }
  if (q.sprintId) conditions.push(eq(t.sprintId, q.sprintId));
  if (q.milestoneId) conditions.push(eq(t.milestoneId, q.milestoneId));
  if (q.customerId) conditions.push(eq(t.customerId, q.customerId));
  if (q.contactId) conditions.push(eq(t.contactId, q.contactId));
  if (q.personId) conditions.push(eq((t as any).personId, q.personId));

  // CRM-linked only: at least one of the company/person link columns is set.
  if (q.crmLinked) {
    conditions.push(
      or(
        isNotNull(t.customerId),
        isNotNull(t.contactId),
        isNotNull((t as any).counterpartyId),
        isNotNull((t as any).personId),
      )!,
    );
  }

  // parentTaskId filter: if specified show that subtree level; otherwise top-level only
  // when a projectId is scoped (matches api-worker behaviour for project views).
  if (q.parentTaskId !== undefined && q.parentTaskId !== '') {
    conditions.push(eq(t.parentTaskId, q.parentTaskId));
  } else if (q.projectId) {
    conditions.push(isNull(t.parentTaskId));
  }

  // Value filters
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.priority) conditions.push(eq(t.priority, q.priority));
  if (q.type) conditions.push(eq(t.type, q.type));

  // Assignee: myTasks shorthand takes precedence over explicit assigneeId
  const effectiveAssigneeId = q.myTasks ? userId : q.assigneeId;
  if (effectiveAssigneeId) {
    conditions.push(
      or(
        eq(t.assigneeId, effectiveAssigneeId),
        sql`${t.assigneeIds}::jsonb @> ${JSON.stringify([effectiveAssigneeId])}::jsonb`,
      )!,
    );
  }

  if (q.search) {
    const term = `%${q.search}%`;
    const searchClauses = [
      like(t.title, term),
      like(t.description, term),
      like((t as any).key, term),
    ];
    // Let users find a task by its number: "TASK-1042", "#1042", or "1042".
    const numberMatch = q.search.trim().replace(/^#/, '').replace(/^task-/i, '');
    if (/^\d+$/.test(numberMatch)) {
      searchClauses.push(eq(t.number, Number(numberMatch)));
    }
    conditions.push(or(...searchClauses)!);
  }

  if (q.labelIds && q.labelIds.length > 0) {
    conditions.push(
      sql`${t.labels} ?| array[${sql.join(
        q.labelIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]`,
    );
  }

  if (q.dueDateBucket) {
    conditions.push(dueDateBucketCondition(q.dueDateBucket, t.dueDate));
  }
  if (q.dueDateFrom) {
    conditions.push(gte(t.dueDate, new Date(q.dueDateFrom)));
  }
  if (q.dueDateTo) {
    conditions.push(lt(t.dueDate, new Date(q.dueDateTo)));
  }

  // Cursor support (used by My Tasks / global surfaces)
  let cursorCondition: any = undefined;
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur?.createdAt) {
      cursorCondition = sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
      conditions.push(cursorCondition);
    }
  }

  // Count (without cursor condition)
  const countConditions = cursorCondition
    ? conditions.slice(0, -1)
    : conditions;
  const countWhere = countConditions.length ? and(...countConditions) : undefined;
  const where = conditions.length ? and(...conditions) : undefined;

  try {
    // Sort
    const sortDir = q.sortDirection === 'desc' ? desc : asc;
    const sortColumn = resolveTaskSortColumn(q.sortField, t);

    // When cursor pagination is active (cursor param present or no projectId),
    // use cursor. When projectId is set and page > 1, use offset (project list).
    const useCursor = q.cursor !== undefined || !q.projectId;
    const fetchLimit = useCursor ? q.limit + 1 : q.pageSize;
    const offset = useCursor ? 0 : (q.page - 1) * q.pageSize;

    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(sortDir(sortColumn), desc(t.id))
        .limit(fetchLimit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(countWhere),
    ]);

    const totalCount = Number(countRes[0]?.count ?? 0);

    let data: any[];
    let paginationMeta: any;

    if (useCursor) {
      const hasMore = rows.length > q.limit;
      data = hasMore ? rows.slice(0, q.limit) : rows;
      const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
      paginationMeta = cursorPagination(totalCount, hasMore, nextCursor);
    } else {
      data = rows;
      const hasMore = offset + rows.length < totalCount;
      const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].id : null;
      paginationMeta = cursorPagination(totalCount, hasMore, nextCursor);
    }

    // Enrichment
    const assigneeEnriched = q.enrich ? await enrichTasksWithAssignees(db, data) : data;
    // Phase 3: customFields comes from the typed values table, not the blob.
    // Batched — two extra queries for the whole page, regardless of page size.
    const enriched = await hydrateCustomFields(db, 'task', assigneeEnriched);

    // Subtask tree / counts
    // Descendants returned in the same payload (includeSubtasks tree) get
    // attachment counts too — tracked here so the batched query below covers them.
    let descendantRows: any[] = [];
    if (enriched.length > 0) {
      if (q.includeSubtasks && q.projectId) {
        let frontier: string[] = enriched.map((row: any) => row.id);
        const allDescendants: any[] = [];
        for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
          const children = await db
            .select()
            .from(t)
            .where(
              and(
                eq(t.projectId, q.projectId),
                inArray(t.parentTaskId, frontier),
                isNull(t.deletedAt),
              ),
            )
            .orderBy(desc(t.position), desc(t.createdAt), desc(t.id));
          if (children.length === 0) break;
          allDescendants.push(...children);
          frontier = children.map((child: any) => child.id);
        }

        // Phase 3: hydrate the whole descendant set in one batch too.
        const enrichedDesc =
          allDescendants.length > 0
            ? await hydrateCustomFields(
                db,
                'task',
                await enrichTasksWithAssignees(db, allDescendants),
              )
            : [];
        descendantRows = enrichedDesc;

        const childrenByParent = new Map<string, any[]>();
        for (const row of enrichedDesc) {
          const pid = row.parentTaskId as string | null;
          if (!pid) continue;
          const entry = childrenByParent.get(pid);
          if (entry) entry.push(row);
          else childrenByParent.set(pid, [row]);
        }

        const attach = (node: any) => {
          const kids = childrenByParent.get(node.id) || [];
          node.children = kids;
          node.subtaskCount = kids.length;
          node.completedSubtaskCount = kids.filter((k: any) => k.status === 'done').length;
          for (const k of kids) attach(k);
        };
        for (const top of enriched) attach(top);
      } else {
        const parentIds = enriched.map((row: any) => row.id);
        const subtaskCounts = await db
          .select({
            parentTaskId: t.parentTaskId,
            total: sql<number>`count(*)::int`,
            completed: sql<number>`count(*) filter (where ${t.status} = 'done')::int`,
          })
          .from(t)
          .where(and(inArray(t.parentTaskId, parentIds), isNull(t.deletedAt)))
          .groupBy(t.parentTaskId);

        const countMap = new Map(
          subtaskCounts.map((r: any) => [
            r.parentTaskId,
            { total: r.total, completed: r.completed },
          ]),
        );
        for (const task of enriched) {
          const counts = countMap.get(task.id);
          task.subtaskCount = counts?.total || 0;
          task.completedSubtaskCount = counts?.completed || 0;
        }
      }
    }

    // Attachment counts — ONE batched query over the whole returned payload
    // (top-level page + any includeSubtasks descendants), from the `files`
    // table (entityType='task'), not the custom_fields blob. Skipped when empty.
    const attachmentTargets: any[] = [...enriched, ...descendantRows];
    if (attachmentTargets.length > 0) {
      const attachmentCounts = await db
        .select({
          entityId: schema.files.entityId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.files)
        .where(
          and(
            eq(schema.files.entityType, 'task'),
            inArray(
              schema.files.entityId,
              attachmentTargets.map((row) => row.id),
            ),
            isNull(schema.files.deletedAt),
          ),
        )
        .groupBy(schema.files.entityId);

      const attachmentCountMap = new Map(
        attachmentCounts.map((r: any) => [r.entityId, r.n]),
      );
      for (const task of attachmentTargets) {
        task.attachmentsCount = attachmentCountMap.get(task.id) ?? 0;
      }
    }

    return list(c, enriched, paginationMeta);
  } catch (err) {
    console.error('[app-api/tasks] list failed:', err);
    return error.internal(c, 'Failed to list tasks');
  }
});

// ============================================================================
// PATCH /reorder — Batch reorder tasks by position
// MUST be registered BEFORE /:id to avoid route collision.
// ============================================================================

app.patch(
  '/reorder',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ taskIds: z.array(z.string()).min(1) })),
  async (c) => {
    const db = c.get('tenantDb');
    const { taskIds } = c.req.valid('json');
    const q = c.req.query();
    const projectId = q.projectId;
    if (projectId && !(await canAccessProject(c, projectId))) {
      return error.forbidden(c, PROJECT_MEMBER_DENIED);
    }
    // Guard EVERY task, not just the optional projectId filter — otherwise a
    // caller could reorder arbitrary tasks by id when projectId is omitted.
    for (const taskId of taskIds) {
      if ((await canAccessTaskProject(c, taskId)) === 'denied') {
        return error.forbidden(c, TASK_PROJECT_DENIED);
      }
    }

    try {
      const totalCount = taskIds.length;
      await Promise.all(
        taskIds.map((taskId, index) => {
          const conditions: any[] = [eq(t.id, taskId), isNull(t.deletedAt)];
          if (projectId) conditions.push(eq(t.projectId, projectId));
          return db
            .update(t)
            .set({ position: totalCount - index, updatedAt: new Date() })
            .where(and(...conditions));
        }),
      );
      return success(c, { success: true });
    } catch (err) {
      console.error('[app-api/tasks] reorder failed:', err);
      return error.internal(c, 'Failed to reorder tasks');
    }
  },
);

// ============================================================================
// POST /projects/:projectId — Project-scoped task create
// MUST be before /:id.
// ============================================================================

app.post(
  '/projects/:projectId',
  requirePermission('tasks:create'),
  zValidator('json', createTaskSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    if (!(await canAccessProject(c, projectId))) {
      return error.forbidden(c, PROJECT_MEMBER_DENIED);
    }
    const data = c.req.valid('json') as Record<string, any>;
    try {
      const { row, assigneeIds } = await insertTask(db, data, { projectId, userId });

      // Calendar auto-schedule (synchronous so errors are visible on create)
      try {
        const eventId = await createCalendarEventForTask(db, {
          userId,
          taskId: row.id,
          title: row.title,
          description: (row as any).description ?? null,
          dueDate: (row as any).dueDate ? new Date((row as any).dueDate) : null,
          startDate: (row as any).startDate ? new Date((row as any).startDate) : null,
          durationMinutes: (row as any).duration ?? null,
          priority: (row as any).priority ?? null,
        });
        if (eventId) {
          await db.update(t).set({ calendarEventId: eventId }).where(eq(t.id, row.id));
        }
      } catch (calErr) {
        console.error('[app-api/tasks] calendar auto-schedule failed:', calErr);
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, projectId, title: row.title },
      });
      dispatchGithubOutboundSync(c, { taskId: row.id, projectId, kinds: ['create'] });
      dispatchAssignmentNotifications(c, {
        assigneeIds,
        taskId: row.id,
        taskTitle: row.title,
        projectId,
        taskPriority: (row as any).priority ?? null,
        dueDate: (row as any).dueDate ?? null,
        taskDescription: (row as any).description ?? null,
      });

      const [enriched] = await enrichTasksWithAssignees(db, [row]);
      return success(c, enriched, 201);
    } catch (err) {
      console.error('[app-api/tasks] project create failed:', err);
      return error.internal(c, 'Failed to create task');
    }
  },
);

// ============================================================================
// GET /:id — Single task with assignee enrichment + subtask counts
// ============================================================================

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Task', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, TASK_PROJECT_DENIED);
    }

    const [assigneeEnriched] = await enrichTasksWithAssignees(db, [row]);
    // Phase 3: customFields comes from the typed values table, not the blob.
    const enriched = await hydrateCustomFieldsOne(db, 'task', assigneeEnriched);

    const subtaskCountResult = await db
      .select({
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${t.status} = 'done')::int`,
      })
      .from(t)
      .where(and(eq(t.parentTaskId, id), isNull(t.deletedAt)));

    // Attachments now live as `files` rows (entityType='task'), not the
    // custom_fields blob. Map each row to the frontend TaskAttachment shape.
    const attachmentRows = await db
      .select({
        id: schema.files.id,
        fileName: schema.files.fileName,
        fileKey: schema.files.fileKey,
        fileSize: schema.files.fileSize,
        mimeType: schema.files.mimeType,
        url: schema.files.url,
        storagePath: schema.files.storagePath,
      })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.entityType, 'task'),
          eq(schema.files.entityId, id),
          isNull(schema.files.deletedAt),
        ),
      )
      .orderBy(asc(schema.files.createdAt));

    const attachments = attachmentRows.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      fileKey: f.fileKey ?? f.storagePath,
      fileSize: f.fileSize,
      mimeType: f.mimeType,
      url: f.url ?? '',
    }));

    return success(c, {
      ...enriched,
      subtaskCount: subtaskCountResult[0]?.total || 0,
      completedSubtaskCount: subtaskCountResult[0]?.completed || 0,
      attachments,
    });
  } catch (err) {
    console.error('[app-api/tasks] get failed:', err);
    return error.internal(c, 'Failed to fetch task');
  }
});

// ============================================================================
// Task attachments — backed by `files` rows (entityType='task'), NOT the blob.
//
// Gated on `tasks:update` (not the generic Drive `files:*` perms): attaching to
// a task is editing the task, and the default MEMBER role holds tasks:update
// but NOT files:delete. Routing through the Drive endpoints would 403 a normal
// contributor on removal. Delete is additionally scoped to the parent task, so
// a tasks:update holder can only remove files that belong to a task they can
// edit — never an arbitrary Drive file.
// ============================================================================

const addTaskAttachmentSchema = z.object({
  fileName: z.string().min(1).max(500),
  fileKey: z.string().min(1),
  fileSize: z.number().int().min(0),
  mimeType: z.string().min(1),
  url: z.string().optional(),
});

app.post(
  '/:id/attachments',
  requirePermission('tasks:update'),
  zValidator('json', addTaskAttachmentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const acc = await canAccessTaskProject(c, id);
    if (acc === 'not-found') return error.notFound(c, 'Task', id);
    if (acc === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const data = c.req.valid('json');
    try {
      const created = await createFile(db, {
        fileName: data.fileName,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        fileType: 'file',
        storagePath: data.fileKey,
        fileKey: data.fileKey,
        url: data.url,
        entityType: 'task',
        entityId: id,
        uploadedById: userId,
      });
      // Return the persisted row (real `fil_` id) so the client can reconcile
      // its optimistic entry and never DELETE a stale upload-confirm id.
      return success(
        c,
        {
          id: created.id,
          fileName: created.fileName,
          fileKey: created.fileKey ?? created.storagePath,
          fileSize: created.fileSize,
          mimeType: created.mimeType,
          url: created.url ?? '',
        },
        201,
      );
    } catch (err) {
      console.error('[app-api/tasks] add attachment failed:', err);
      return error.internal(c, 'Failed to add attachment');
    }
  },
);

app.delete('/:id/attachments/:fileId', requirePermission('tasks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const fileId = c.req.param('fileId');
  const acc = await canAccessTaskProject(c, id);
  if (acc === 'not-found') return error.notFound(c, 'Task', id);
  if (acc === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
  try {
    // Scope the delete to THIS task: the file must be an attachment of it.
    const [existing] = await db
      .select({ id: schema.files.id })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.id, fileId),
          eq(schema.files.entityType, 'task'),
          eq(schema.files.entityId, id),
          isNull(schema.files.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return error.notFound(c, 'Attachment', fileId);
    await db
      .update(schema.files)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.files.id, fileId));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/tasks] remove attachment failed:', err);
    return error.internal(c, 'Failed to remove attachment');
  }
});

// ============================================================================
// GET /:id/subtasks — List direct subtasks with their own subtask counts
// ============================================================================

app.get('/:id/subtasks', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const _acc = await canAccessTaskProject(c, id);
  if (_acc === 'not-found') return error.notFound(c, 'Task', id);
  if (_acc === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
  try {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.parentTaskId, id), isNull(t.deletedAt)))
      .orderBy(t.position);

    // Phase 3: customFields comes from the typed values table, not the blob.
    const enriched = await hydrateCustomFields(
      db,
      'task',
      await enrichTasksWithAssignees(db, rows),
    );

    if (enriched.length > 0) {
      const childIds = enriched.map((row: any) => row.id);
      const subtaskCounts = await db
        .select({
          parentTaskId: t.parentTaskId,
          total: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) filter (where ${t.status} = 'done')::int`,
        })
        .from(t)
        .where(and(inArray(t.parentTaskId, childIds), isNull(t.deletedAt)))
        .groupBy(t.parentTaskId);

      const countMap = new Map(
        subtaskCounts.map((r: any) => [
          r.parentTaskId,
          { total: r.total, completed: r.completed },
        ]),
      );
      for (const task of enriched) {
        const counts = countMap.get(task.id);
        task.subtaskCount = counts?.total || 0;
        task.completedSubtaskCount = counts?.completed || 0;
      }

      // Attachment counts — ONE batched query from the `files` table
      // (entityType='task'), not the custom_fields blob.
      const attachmentCounts = await db
        .select({
          entityId: schema.files.entityId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.files)
        .where(
          and(
            eq(schema.files.entityType, 'task'),
            inArray(schema.files.entityId, childIds),
            isNull(schema.files.deletedAt),
          ),
        )
        .groupBy(schema.files.entityId);

      const attachmentCountMap = new Map(
        attachmentCounts.map((r: any) => [r.entityId, r.n]),
      );
      for (const task of enriched) {
        task.attachmentsCount = attachmentCountMap.get(task.id) ?? 0;
      }
    }

    return success(c, enriched);
  } catch (err) {
    console.error('[app-api/tasks] subtasks failed:', err);
    return error.internal(c, 'Failed to fetch subtasks');
  }
});

// ============================================================================
// POST / — Global task create (My Tasks, cross-project)
// ============================================================================

app.post('/', requirePermission('tasks:create'), zValidator('json', createTaskSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const projectId = data.projectId ?? null;
    if (projectId && !(await canAccessProject(c, projectId))) {
      return error.forbidden(c, PROJECT_MEMBER_DENIED);
    }
    const { row, assigneeIds } = await insertTask(db, data, { projectId, userId });

    // Calendar auto-schedule
    try {
      const eventId = await createCalendarEventForTask(db, {
        userId,
        taskId: row.id,
        title: row.title,
        description: (row as any).description ?? null,
        dueDate: (row as any).dueDate ? new Date((row as any).dueDate) : null,
        startDate: (row as any).startDate ? new Date((row as any).startDate) : null,
        durationMinutes: (row as any).duration ?? null,
        priority: (row as any).priority ?? null,
      });
      if (eventId) {
        await db.update(t).set({ calendarEventId: eventId }).where(eq(t.id, row.id));
      }
    } catch (calErr) {
      console.error('[app-api/tasks] calendar auto-schedule failed:', calErr);
    }

    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId, title: row.title },
    });
    dispatchGithubOutboundSync(c, { taskId: row.id, projectId, kinds: ['create'] });
    dispatchAssignmentNotifications(c, {
      assigneeIds,
      taskId: row.id,
      taskTitle: row.title,
      projectId,
      taskPriority: (row as any).priority ?? null,
      dueDate: (row as any).dueDate ?? null,
      taskDescription: (row as any).description ?? null,
    });

    const [enriched] = await enrichTasksWithAssignees(db, [row]);
    return success(c, enriched, 201);
  } catch (err) {
    console.error('[app-api/tasks] create failed:', err);
    return error.internal(c, 'Failed to create task');
  }
});

// ============================================================================
// PATCH /:id/toggle — Done ↔ todo toggle with recurrence support
// ============================================================================

app.patch(
  '/:id/toggle',
  requirePermission('tasks:update'),
  zValidator(
    'json',
    z.object({
      currentStatus: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const data = c.req.valid('json');

    try {
      const [currentTask] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!currentTask) return error.notFound(c, 'Task', id);

      const newStatus =
        data.status || (data.currentStatus === 'done' ? 'todo' : 'done');

      const updateData: Record<string, any> = { status: newStatus, updatedAt: new Date() };
      if (newStatus === 'done') updateData.completedDate = new Date();

      await db.update(t).set(updateData).where(and(eq(t.id, id), isNull(t.deletedAt)));

      // Calendar sync
      if ((currentTask as any).calendarEventId) {
        if (newStatus === 'done' || newStatus === 'cancelled') {
          c.executionCtx.waitUntil(
            cancelCalendarEvent(db, (currentTask as any).calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar cancel failed:', err),
            ),
          );
        } else if (
          (currentTask as any).status === 'done' ||
          (currentTask as any).status === 'cancelled'
        ) {
          c.executionCtx.waitUntil(
            confirmCalendarEvent(db, (currentTask as any).calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar confirm failed:', err),
            ),
          );
        }
      }

      // Recurrence
      let nextTaskId: string | null = null;
      if (newStatus === 'done' && (currentTask as any).repeat) {
        const projectId = (currentTask as any).projectId;
        if (projectId) {
          nextTaskId = await createNextRecurringTask(db, currentTask, projectId);
        }
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: { id, title: (currentTask as any).title, status: newStatus },
      });

      if (newStatus !== (currentTask as any).status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: (currentTask as any).projectId,
          kinds: ['status'],
        });
      }

      return success(c, { id, status: newStatus, ...(nextTaskId && { nextTaskId }) });
    } catch (err) {
      console.error('[app-api/tasks] toggle failed:', err);
      return error.internal(c, 'Failed to toggle task');
    }
  },
);

// ============================================================================
// PATCH /:id/status — Status-only update with recurrence + calendar sync
// ============================================================================

app.patch(
  '/:id/status',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ status: z.string() })),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const { status } = c.req.valid('json');

    try {
      const [currentTask] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!currentTask) return error.notFound(c, 'Task', id);

      const updateData: Record<string, any> = { status, updatedAt: new Date() };
      if (status === 'done') updateData.completedDate = new Date();

      await db.update(t).set(updateData).where(and(eq(t.id, id), isNull(t.deletedAt)));

      if ((currentTask as any).calendarEventId) {
        const wasTerminal =
          (currentTask as any).status === 'done' ||
          (currentTask as any).status === 'cancelled';
        const isTerminal = status === 'done' || status === 'cancelled';
        if (!wasTerminal && isTerminal) {
          c.executionCtx.waitUntil(
            cancelCalendarEvent(db, (currentTask as any).calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar cancel failed:', err),
            ),
          );
        } else if (wasTerminal && !isTerminal) {
          c.executionCtx.waitUntil(
            confirmCalendarEvent(db, (currentTask as any).calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar confirm failed:', err),
            ),
          );
        }
      }

      let nextTaskId: string | null = null;
      if (status === 'done' && (currentTask as any).repeat) {
        const projectId = (currentTask as any).projectId;
        if (projectId) {
          nextTaskId = await createNextRecurringTask(db, currentTask, projectId);
        }
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: { id, title: (currentTask as any).title, status },
      });

      if (status !== (currentTask as any).status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: (currentTask as any).projectId,
          kinds: ['status'],
        });
      }

      return success(c, { id, status, ...(nextTaskId && { nextTaskId }) });
    } catch (err) {
      console.error('[app-api/tasks] status update failed:', err);
      return error.internal(c, 'Failed to update task status');
    }
  },
);

// ============================================================================
// PATCH /:id/position — Kanban drag & drop (position + optional status)
// ============================================================================

app.patch(
  '/:id/position',
  requirePermission('tasks:update'),
  zValidator(
    'json',
    z.object({
      position: z.number().optional(),
      boardPosition: z.number().optional(),
      status: z.string().optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const data = c.req.valid('json');

    try {
      let currentTask: any = null;
      if (data.status) {
        const [task] = await db
          .select()
          .from(t)
          .where(and(eq(t.id, id), isNull(t.deletedAt)))
          .limit(1);
        currentTask = task;
        if (!currentTask) return error.notFound(c, 'Task', id);
      }

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (data.position !== undefined) updateData.position = data.position;
      if (data.boardPosition !== undefined) updateData.boardPosition = data.boardPosition;
      if (data.status) {
        updateData.status = data.status;
        if (data.status === 'done') updateData.completedDate = new Date();
      }

      await db.update(t).set(updateData).where(and(eq(t.id, id), isNull(t.deletedAt)));

      // Calendar sync on status change
      if (currentTask?.calendarEventId && data.status) {
        const wasTerminal =
          currentTask.status === 'done' || currentTask.status === 'cancelled';
        const isTerminal = data.status === 'done' || data.status === 'cancelled';
        if (!wasTerminal && isTerminal) {
          c.executionCtx.waitUntil(
            cancelCalendarEvent(db, currentTask.calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar cancel failed:', err),
            ),
          );
        } else if (wasTerminal && !isTerminal) {
          c.executionCtx.waitUntil(
            confirmCalendarEvent(db, currentTask.calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar confirm failed:', err),
            ),
          );
        }
      }

      let nextTaskId: string | null = null;
      if (data.status === 'done' && currentTask?.repeat) {
        const projectId = currentTask.projectId;
        if (projectId) {
          nextTaskId = await createNextRecurringTask(db, currentTask, projectId);
        }
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: {
          id,
          title: currentTask?.title ?? '',
          ...(data.position !== undefined && { position: data.position }),
          ...(data.status && { status: data.status }),
        },
      });

      if (data.status && currentTask && data.status !== currentTask.status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: currentTask.projectId,
          kinds: ['status'],
        });
      }

      return success(c, {
        id,
        ...(data.position !== undefined && { position: data.position }),
        ...(data.status && { status: data.status }),
        ...(nextTaskId && { nextTaskId }),
      });
    } catch (err) {
      console.error('[app-api/tasks] position update failed:', err);
      return error.internal(c, 'Failed to update task position');
    }
  },
);

// ============================================================================
// PUT /:id/dependencies — Update dependsOn / blocks with reciprocal sync
// ============================================================================

app.put(
  '/:id/dependencies',
  requirePermission('tasks:update'),
  zValidator(
    'json',
    z.object({
      dependsOn: z.array(z.string()).optional(),
      blocks: z.array(z.string()).optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const data = c.req.valid('json');

    try {
      if (data.dependsOn && data.dependsOn.length > 0) {
        const hasCycle = await detectCycle(db, id, data.dependsOn);
        if (hasCycle) return error.badRequest(c, 'Circular dependency detected');
      }

      const [currentTask] = await db
        .select({ dependsOn: t.dependsOn, blocks: t.blocks })
        .from(t)
        .where(eq(t.id, id))
        .limit(1);
      if (!currentTask) return error.notFound(c, 'Task', id);

      const oldDependsOn: string[] = (currentTask.dependsOn as string[]) || [];
      const oldBlocks: string[] = (currentTask.blocks as string[]) || [];
      const newDependsOn = data.dependsOn ?? oldDependsOn;
      const newBlocks = data.blocks ?? oldBlocks;

      await db
        .update(t)
        .set({ dependsOn: newDependsOn, blocks: newBlocks, updatedAt: new Date() })
        .where(eq(t.id, id));

      // Reciprocal sync
      const addedDeps = newDependsOn.filter((dep) => !oldDependsOn.includes(dep));
      const removedDeps = oldDependsOn.filter((dep) => !newDependsOn.includes(dep));
      const addedBlocks = newBlocks.filter((b) => !oldBlocks.includes(b));
      const removedBlocks = oldBlocks.filter((b) => !newBlocks.includes(b));

      for (const depId of addedDeps) {
        const [dep] = await db
          .select({ blocks: t.blocks })
          .from(t)
          .where(eq(t.id, depId))
          .limit(1);
        if (dep) {
          await db
            .update(t)
            .set({
              blocks: [...new Set([...((dep.blocks as string[]) || []), id])],
              updatedAt: new Date(),
            })
            .where(eq(t.id, depId));
        }
      }
      for (const depId of removedDeps) {
        const [dep] = await db
          .select({ blocks: t.blocks })
          .from(t)
          .where(eq(t.id, depId))
          .limit(1);
        if (dep) {
          await db
            .update(t)
            .set({
              blocks: ((dep.blocks as string[]) || []).filter((bid) => bid !== id),
              updatedAt: new Date(),
            })
            .where(eq(t.id, depId));
        }
      }
      for (const blockId of addedBlocks) {
        const [blocked] = await db
          .select({ dependsOn: t.dependsOn })
          .from(t)
          .where(eq(t.id, blockId))
          .limit(1);
        if (blocked) {
          await db
            .update(t)
            .set({
              dependsOn: [...new Set([...((blocked.dependsOn as string[]) || []), id])],
              updatedAt: new Date(),
            })
            .where(eq(t.id, blockId));
        }
      }
      for (const blockId of removedBlocks) {
        const [blocked] = await db
          .select({ dependsOn: t.dependsOn })
          .from(t)
          .where(eq(t.id, blockId))
          .limit(1);
        if (blocked) {
          await db
            .update(t)
            .set({
              dependsOn: ((blocked.dependsOn as string[]) || []).filter((bid) => bid !== id),
              updatedAt: new Date(),
            })
            .where(eq(t.id, blockId));
        }
      }

      return success(c, { id, dependsOn: newDependsOn, blocks: newBlocks });
    } catch (err) {
      console.error('[app-api/tasks] dependencies update failed:', err);
      return error.internal(c, 'Failed to update dependencies');
    }
  },
);

// ============================================================================
// POST /:id/move — Move a task (and its subtasks) to another project.
//
// Gated behind the `weldflow-move-task` Flagship flag for gradual rollout, so
// the endpoint is forbidden for users outside the rollout even if called
// directly. Project-scoped references (sprint / milestone / pipeline stage /
// the PROJ-123 key / board position) are CLEARED & RESET to the destination
// project's defaults; parentTaskId is preserved so the hierarchy stays intact.
// ============================================================================

app.post(
  '/:id/move',
  requirePermission('tasks:update'),
  zValidator('json', moveTaskSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { projectId: destProjectId } = c.req.valid('json');
    // Must be able to act on both the task's SOURCE project and the DESTINATION.
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    if (destProjectId && !(await canAccessProject(c, destProjectId))) {
      return error.forbidden(c, 'You are not a member of the destination project');
    }

    // Rollout gate — feature is hidden unless the flag is on for this user.
    const flags = c.get('flags');
    if (!flags || !(await flags.isOn('weldflow-move-task'))) {
      return error.forbidden(c, 'Moving tasks between projects is not available.');
    }

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Task', id);

      // No-op when the task is already in the destination project.
      if ((existing as any).projectId === destProjectId) {
        return success(c, { id, projectId: destProjectId, movedSubtaskCount: 0 });
      }

      // Destination project must exist (and not be soft-deleted).
      const [destProject] = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, destProjectId), isNull(schema.projects.deletedAt)))
        .limit(1);
      if (!destProject) return error.notFound(c, 'Project', destProjectId);

      // Destination's default pipeline stage (lowest position) drives the
      // reset stage + system status. Falls back to a plain "todo" backlog when
      // the project has no pipeline stages.
      const [defaultStage] = await db
        .select({
          id: schema.projectPipelineStages.id,
          systemStatus: schema.projectPipelineStages.systemStatus,
        })
        .from(schema.projectPipelineStages)
        .where(
          and(
            eq(schema.projectPipelineStages.projectId, destProjectId),
            isNull(schema.projectPipelineStages.deletedAt),
          ),
        )
        .orderBy(asc(schema.projectPipelineStages.position))
        .limit(1);
      const resetStageId = defaultStage?.id ?? null;
      const resetStatus = defaultStage?.systemStatus ?? 'todo';

      // Gather the full descendant subtree (BFS over parentTaskId, bounded by
      // MAX_SUBTASK_DEPTH) so subtasks travel with their parent.
      const descendantIds: string[] = [];
      let frontier = [id];
      for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
        const children = await db
          .select({ id: t.id })
          .from(t)
          .where(and(inArray(t.parentTaskId, frontier), isNull(t.deletedAt)));
        const childIds = children.map((row) => row.id).filter((cid) => cid !== id);
        if (childIds.length === 0) break;
        descendantIds.push(...childIds);
        frontier = childIds;
      }

      // Next board position at the bottom of the destination project's list.
      const [positionRow] = await db
        .select({ maxPosition: sql<number>`coalesce(max(${t.position}), 0)::int` })
        .from(t)
        .where(and(eq(t.projectId, destProjectId), isNull(t.deletedAt)));
      const basePosition = (positionRow?.maxPosition || 0) + 1;

      const now = new Date();
      const allIds = [id, ...descendantIds];

      // Reset & move each task. parentTaskId is preserved; the key is cleared
      // (its prefix belonged to the old project) and sprint/milestone/stage are
      // reset to the destination's defaults.
      for (let i = 0; i < allIds.length; i++) {
        await db
          .update(t)
          .set({
            projectId: destProjectId,
            sprintId: null,
            milestoneId: null,
            stageId: resetStageId,
            status: resetStatus,
            key: null,
            position: basePosition + i,
            boardPosition: null,
            updatedAt: now,
          })
          .where(eq(t.id, allIds[i]));
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: {
          id,
          title: (existing as any).title,
          projectId: destProjectId,
          status: resetStatus,
        },
      });

      return success(c, {
        id,
        projectId: destProjectId,
        movedSubtaskCount: descendantIds.length,
      });
    } catch (err) {
      console.error('[app-api/tasks] move failed:', err);
      return error.internal(c, 'Failed to move task');
    }
  },
);

// ============================================================================
// PATCH /:id — Full update with calendar sync, recurrence, notifications
// ============================================================================

app.patch(
  '/:id',
  requirePermission('tasks:update'),
  zValidator('json', updateTaskSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const workspaceId = c.get('workspaceId');
    const id = c.req.param('id');
    const _taskAccess = await canAccessTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
    const data = c.req.valid('json') as Record<string, any>;

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Task', id);

      const update: Record<string, any> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) {
          if ((k === 'startDate' || k === 'dueDate') && v) {
            update[k] = new Date(v as string);
          } else {
            update[k] = v;
          }
        }
      }

      // Sync assigneeId <-> assigneeIds
      if (data.assigneeIds !== undefined) {
        const ids = (data.assigneeIds as string[]) || [];
        update.assigneeIds = ids.length > 0 ? ids : null;
        update.assigneeId = ids[0] || null;
      } else if (data.assigneeId !== undefined) {
        update.assigneeIds = data.assigneeId ? [data.assigneeId] : null;
      }

      // Derive status from stage
      if (data.stageId) {
        const [stage] = await db
          .select({ systemStatus: schema.projectPipelineStages.systemStatus })
          .from(schema.projectPipelineStages)
          .where(eq(schema.projectPipelineStages.id, data.stageId))
          .limit(1);
        if (stage?.systemStatus) update.status = stage.systemStatus;
      }

      const resolvedStatus = update.status ?? (existing as any).status;
      if (resolvedStatus === 'done' && (existing as any).status !== 'done') {
        update.completedDate = new Date();
      }

      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

      // Phase 1 dual-write: mirror the customFields blob into the typed values table.
      await syncValuesForEntity(db, 'task', id, data.customFields);

      // Calendar sync
      const calendarEventId = (existing as any).calendarEventId;
      const newDueDate =
        data.dueDate !== undefined
          ? data.dueDate
            ? new Date(data.dueDate as string)
            : null
          : (existing as any).dueDate;
      const newStartDate =
        data.startDate !== undefined
          ? data.startDate
            ? new Date(data.startDate as string)
            : null
          : (existing as any).startDate;

      if (
        calendarEventId &&
        (data.dueDate !== undefined ||
          data.startDate !== undefined ||
          data.title !== undefined ||
          data.duration !== undefined)
      ) {
        c.executionCtx.waitUntil(
          rescheduleCalendarEvent(db, {
            calendarEventId,
            userId,
            taskId: id,
            title: (data.title as string) || (existing as any).title,
            description:
              data.description !== undefined
                ? (data.description as string | null)
                : (existing as any).description,
            dueDate: newDueDate,
            startDate: newStartDate,
            durationMinutes:
              data.duration !== undefined
                ? (data.duration as number | null)
                : (existing as any).duration,
            priority: (data.priority as string | null) ?? (existing as any).priority,
          })
            .then((newEventId) =>
              db.update(t).set({ calendarEventId: newEventId }).where(eq(t.id, id)),
            )
            .catch((err) =>
              console.error('[app-api/tasks] calendar reschedule failed:', err),
            ),
        );
      } else if (!calendarEventId) {
        c.executionCtx.waitUntil(
          createCalendarEventForTask(db, {
            userId,
            taskId: id,
            title: (data.title as string) || (existing as any).title,
            description:
              data.description !== undefined
                ? (data.description as string | null)
                : (existing as any).description,
            dueDate: newDueDate,
            startDate: newStartDate,
            durationMinutes:
              data.duration !== undefined
                ? (data.duration as number | null)
                : (existing as any).duration,
            priority: (data.priority as string | null) ?? (existing as any).priority,
          })
            .then((eventId) =>
              db.update(t).set({ calendarEventId: eventId }).where(eq(t.id, id)),
            )
            .catch((err) =>
              console.error('[app-api/tasks] calendar event creation failed:', err),
            ),
        );
      }

      // Status → done/cancelled: cancel calendar event
      if (calendarEventId) {
        const oldStatus = (existing as any).status;
        const wasTerminal = oldStatus === 'done' || oldStatus === 'cancelled';
        const isTerminal = resolvedStatus === 'done' || resolvedStatus === 'cancelled';
        if (!wasTerminal && isTerminal) {
          c.executionCtx.waitUntil(
            cancelCalendarEvent(db, calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar cancel failed:', err),
            ),
          );
        } else if (wasTerminal && !isTerminal) {
          c.executionCtx.waitUntil(
            confirmCalendarEvent(db, calendarEventId).catch((err) =>
              console.error('[app-api/tasks] calendar confirm failed:', err),
            ),
          );
        }

        // Priority changed without date changes → reschedule
        const priorityChanged =
          data.priority !== undefined && data.priority !== (existing as any).priority;
        const datesChanged = data.dueDate !== undefined || data.startDate !== undefined;
        if (priorityChanged && !datesChanged) {
          c.executionCtx.waitUntil(
            rescheduleCalendarEvent(db, {
              calendarEventId,
              userId,
              taskId: id,
              title: (data.title as string) || (existing as any).title,
              description:
                data.description !== undefined
                  ? (data.description as string | null)
                  : (existing as any).description,
              dueDate: newDueDate,
              startDate: newStartDate,
              durationMinutes:
                data.duration !== undefined
                  ? (data.duration as number | null)
                  : (existing as any).duration,
              priority: data.priority as string,
            })
              .then((newEventId) =>
                db.update(t).set({ calendarEventId: newEventId }).where(eq(t.id, id)),
              )
              .catch((err) =>
                console.error(
                  '[app-api/tasks] calendar priority reschedule failed:',
                  err,
                ),
              ),
          );
        }
      }

      // Recurrence: create next task if status changed to done
      let nextTaskId: string | null = null;
      const wasNotDone = (existing as any).status !== 'done';
      if (wasNotDone && resolvedStatus === 'done') {
        const repeatConfig =
          data.repeat !== undefined ? data.repeat : (existing as any).repeat;
        if (repeatConfig) {
          const projectId = (existing as any).projectId;
          if (projectId) {
            nextTaskId = await createNextRecurringTask(
              db,
              { ...existing, ...update, repeat: repeatConfig },
              projectId,
            );
          }
        }
      }

      // Assignment notifications for newly added assignees
      const oldIds: string[] =
        (existing as any).assigneeIds ||
        ((existing as any).assigneeId ? [(existing as any).assigneeId] : []);
      const newIds: string[] =
        update.assigneeIds || (update.assigneeId ? [update.assigneeId] : oldIds);
      const addedAssignees = newIds.filter((aid) => !oldIds.includes(aid));
      if (addedAssignees.length > 0) {
        dispatchAssignmentNotifications(c, {
          assigneeIds: addedAssignees,
          taskId: id,
          taskTitle: (data.title as string) || (existing as any).title,
          projectId: (existing as any).projectId ?? null,
          taskPriority: (data.priority as string | null) ?? (existing as any).priority ?? null,
          dueDate: newDueDate,
          taskDescription:
            data.description !== undefined
              ? (data.description as string | null)
              : (existing as any).description,
        });
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: { id, title: (data.title as string) || (existing as any).title, ...data },
      });

      const ghKinds: GithubOutboundKind[] = [];
      if (data.title !== undefined || data.description !== undefined || data.labels !== undefined) {
        ghKinds.push('update');
      }
      if (resolvedStatus !== (existing as any).status) {
        ghKinds.push('status');
      }
      dispatchGithubOutboundSync(c, {
        taskId: id,
        projectId: (existing as any).projectId,
        kinds: ghKinds,
      });

      return success(c, { id, ...data, ...(nextTaskId && { nextTaskId }) });
    } catch (err) {
      console.error('[app-api/tasks] update failed:', err);
      return error.internal(c, 'Failed to update task');
    }
  },
);

// ============================================================================
// DELETE /:id — Soft delete with calendar event cleanup + dependency pruning
// ============================================================================

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const _taskAccess = await canAccessTaskProject(c, id);
  if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
  if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_DENIED);
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Task', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));

    // Delete linked calendar event
    if ((existing as any).calendarEventId) {
      c.executionCtx.waitUntil(
        deleteCalendarEvent(db, (existing as any).calendarEventId).catch((err) =>
          console.error('[app-api/tasks] calendar event delete failed:', err),
        ),
      );
    }

    // Prune from other tasks' dependsOn / blocks
    const projectId = (existing as any).projectId;
    const dependentConditions: any[] = [isNull(t.deletedAt)];
    if (projectId) dependentConditions.push(eq(t.projectId, projectId));
    dependentConditions.push(
      or(
        sql`${t.dependsOn}::jsonb @> ${JSON.stringify([id])}::jsonb`,
        sql`${t.blocks}::jsonb @> ${JSON.stringify([id])}::jsonb`,
      )!,
    );

    const dependentTasks = await db
      .select({ id: t.id, dependsOn: t.dependsOn, blocks: t.blocks })
      .from(t)
      .where(and(...dependentConditions));

    for (const dep of dependentTasks) {
      const updatedDependsOn = ((dep.dependsOn as string[]) || []).filter(
        (did) => did !== id,
      );
      const updatedBlocks = ((dep.blocks as string[]) || []).filter((bid) => bid !== id);
      await db
        .update(t)
        .set({ dependsOn: updatedDependsOn, blocks: updatedBlocks, updatedAt: new Date() })
        .where(eq(t.id, dep.id));
    }

    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: id,
      action: 'deleted',
      data: { id, title: (existing as any).title },
    });

    dispatchGithubOutboundSync(c, {
      taskId: id,
      projectId: (existing as any).projectId,
      kinds: ['delete'],
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/tasks] delete failed:', err);
    return error.internal(c, 'Failed to delete task');
  }
});

export const tasksRoutes = app;

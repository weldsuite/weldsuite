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
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, ilike, isNull, lt, notInArray, or, sql, type Column, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { sendTaskAssignmentNotification } from '@weldsuite/notifications';
import {
  createCalendarEventForTask,
  rescheduleCalendarEvent,
  cancelCalendarEvent,
  confirmCalendarEvent,
  fetchTaskScheduledSlots,
  nextAutoScheduledReplanAt,
} from '@weldsuite/db/lib/calendar-sync';
import { syncWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  taskStatusAliases,
  taskStatusSchema,
} from '@weldsuite/app-api-client/schemas/tasks';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { taskAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { assigneeIdsInvolved, buildTaskChanges } from '../../lib/task-changes';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '@weldsuite/core-domain/custom-field-values';
import { getMasterDb, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { createFile } from '@weldsuite/core-domain/files';
import {
  accessibleProjectIds,
  canAccessProject,
  canAccessTaskProject,
  canWriteProject,
  canWriteTaskProject,
} from '../../lib/project-access';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { MAX_SUBTASK_DEPTH, softDeleteTaskTree } from '@weldsuite/flow-domain/task-tree';
import { applyStatusChange, stageForStatus } from '@weldsuite/flow-domain/task-stage';
import { createNextOccurrence, isCompletion, type RecurringSource } from '@weldsuite/flow-domain/recurrence';
import { changedTaskReferences, findInvalidTaskReference } from '@weldsuite/flow-domain/task-relations';
import { dayBoundsInTimezone, workspaceDayBounds, type DayBounds } from '@weldsuite/flow-domain/day-boundaries';
import { containsPattern, queryBoolean } from '../../lib/query-params';
import { taskInLiveProject } from '../../lib/task-scope';

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
 * The day boundaries come from `bounds`: pass the workspace-timezone ones
 * (`workspaceDayBounds`) so "today" is the workspace's day, not the UTC day a
 * Worker's clock would otherwise cut it at. Defaults to UTC for callers with no
 * database at hand.
 */
export function dueDateBucketCondition(
  bucket: DueDateBucket,
  dueDateColumn: any,
  bounds: DayBounds = dayBoundsInTimezone('UTC'),
) {
  const { startOfToday, startOfTomorrow, startOfNextWeek } = bounds;

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

/**
 * Keyset condition selecting the rows that come after `cursor` under the list
 * ordering `ORDER BY <sortColumn> <direction>, id DESC`. The cursor has to walk
 * the same order the page query sorts by — filtering on anything else (it used
 * to filter on createdAt while sorting by position) makes the next page repeat
 * rows from the previous one. Null placement mirrors Postgres' defaults:
 * ASC puts NULLs last, DESC puts them first.
 */
export function taskCursorCondition(
  sortColumn: Column,
  direction: 'asc' | 'desc',
  cursor: { id: string; sortValue: unknown },
  tasksTable: typeof schema.tasks,
): SQL {
  const afterId = lt(tasksTable.id, cursor.id);
  if (cursor.sortValue === null || cursor.sortValue === undefined) {
    const nullTail = and(isNull(sortColumn), afterId)!;
    return direction === 'asc' ? nullTail : or(isNotNull(sortColumn), nullTail)!;
  }
  const beyond =
    direction === 'asc'
      ? or(gt(sortColumn, cursor.sortValue), isNull(sortColumn))!
      : lt(sortColumn, cursor.sortValue);
  return or(beyond, and(eq(sortColumn, cursor.sortValue), afterId))!;
}

// ============================================================================
// Enrichment helpers
// ============================================================================

/** Workspace members referenced by the tasks' assignee fields, keyed by user id. */
async function fetchAssigneeMap(db: any, taskResults: any[]): Promise<Map<string, any>> {
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
  return memberMap;
}

/** Display names for the audit trail's assignee line, keyed by user id. */
async function fetchAssigneeNames(db: any, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const members = await fetchAssigneeMap(db, [{ assigneeIds: ids }]);
  const names = new Map<string, string>();
  for (const [userId, member] of members) {
    if (member?.name) names.set(userId, member.name);
  }
  return names;
}

/**
 * CRM link: `tasks.customer_id` holds a company id. Resolve it to a display
 * object in one batched query so list/detail views (CRM My Tasks, task panel)
 * can show the linked record without a second round trip.
 */
async function fetchLinkedCompanyMap(
  db: any,
  taskResults: any[],
): Promise<Map<string, { id: string; name: string; avatar: string | null }>> {
  const companyIds = new Set<string>();
  for (const row of taskResults) {
    if (typeof row.customerId === 'string' && row.customerId) companyIds.add(row.customerId);
  }
  const companyMap = new Map<string, { id: string; name: string; avatar: string | null }>();
  if (companyIds.size > 0) {
    const { companies } = schema;
    const companyRows = await db
      .select({
        id: companies.id,
        name: companies.displayName,
        avatar: companies.avatarUrl,
      })
      .from(companies)
      .where(and(inArray(companies.id, [...companyIds]), isNull(companies.deletedAt)));
    for (const company of companyRows) {
      companyMap.set(company.id, {
        id: company.id,
        name: company.name,
        avatar: company.avatar ?? null,
      });
    }
  }
  return companyMap;
}

/**
 * CRM link: `tasks.person_id` holds a person id — the counterpart to
 * `fetchLinkedCompanyMap` above. A task links to a company XOR a person, but
 * both are resolved the same way so the client can tell which one applies.
 */
async function fetchLinkedPersonMap(
  db: Database,
  taskResults: ReadonlyArray<{ personId?: unknown }>,
): Promise<Map<string, { id: string; name: string; avatar: string | null }>> {
  const personIds = new Set<string>();
  for (const row of taskResults) {
    if (typeof row.personId === 'string' && row.personId) personIds.add(row.personId);
  }
  const personMap = new Map<string, { id: string; name: string; avatar: string | null }>();
  if (personIds.size > 0) {
    const { people } = schema;
    const personRows = await db
      .select({
        id: people.id,
        name: people.displayName,
        avatar: people.avatarUrl,
      })
      .from(people)
      .where(and(inArray(people.id, [...personIds]), isNull(people.deletedAt)));
    for (const person of personRows) {
      personMap.set(person.id, {
        id: person.id,
        name: person.name,
        avatar: person.avatar ?? null,
      });
    }
  }
  return personMap;
}

/**
 * Enrich task rows with assignee info from workspaceMembers, the
 * currently-scheduled calendar slot (if any) and the linked CRM company/person.
 */
export async function enrichTasksWithAssignees(db: any, taskResults: any[]) {
  if (taskResults.length === 0) return taskResults;

  const memberMap = await fetchAssigneeMap(db, taskResults);

  const taskIds = taskResults
    .map((t: any) => t.id)
    .filter((id: any): id is string => typeof id === 'string');
  const eventMap = await fetchTaskScheduledSlots(db, taskIds);

  const companyMap = await fetchLinkedCompanyMap(db, taskResults);
  const personMap = await fetchLinkedPersonMap(db, taskResults);

  return taskResults.map((task: any) => {
    let ids: string[] = [];
    if (Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0) ids = task.assigneeIds;
    else if (task.assigneeId) ids = [task.assigneeId];

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
      linkedCompany: task.customerId ? (companyMap.get(task.customerId) ?? null) : null,
      linkedPerson: task.personId ? (personMap.get(task.personId) ?? null) : null,
    };
  });
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
// task that belongs to a project requires membership of that project, and
// mutating it requires write access (project viewers are read-only).
const TASK_PROJECT_DENIED = "You are not a member of this task's project";
const PROJECT_MEMBER_DENIED = 'You are not a member of this project';
const TASK_PROJECT_WRITE_DENIED = "You do not have write access to this task's project";
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';

/**
 * Thin wrapper kept for call-site continuity: the insert logic itself lives
 * in `@weldsuite/flow-domain/tasks` (`createTask`), shared with connect-api's
 * WeldConnect `create_task` action.
 */
async function insertTask(
  db: Variables['tenantDb'],
  data: Record<string, any>,
  opts: { projectId?: string | null; userId: string },
) {
  return createTask(db, data, opts);
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
  // Web in-app opens the task itself via the stable `/weldflow/task/{id}` link
  // (it resolves the project and opens the panel); mobile push uses
  // projectId/taskId from the Expo data payload for a direct
  // `/task/{projectId}/{taskId}` deep link.
  const actionUrl = opts.projectId
    ? `/weldflow/task/${opts.taskId}`
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
            projectId: opts.projectId,
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
        // A handful of kinds, each its own workflow instance: create them together.
        await Promise.all(
          opts.kinds.map(async (kind) => {
            try {
              await binding.create({
                id: `github-outbound-${opts.taskId}-${kind}-${bucket}`,
                params: { workspaceId, taskId: opts.taskId, kind },
              });
            } catch {
              // Duplicate within the debounce window — already dispatched.
            }
          }),
        );
      } catch (err) {
        console.error('[app-api/tasks] github outbound dispatch failed:', err);
      }
    })(),
  );
}

// ============================================================================
// Shared mutation helpers (status / position / update handlers)
// ============================================================================

type TaskCtx = Context<{ Bindings: Env; Variables: Variables }>;
type TaskDb = Variables['tenantDb'];

/** Row-level guard shared by the by-id handlers: a Response to return, or null when access is allowed. */
async function guardTaskWrite(c: TaskCtx, id: string): Promise<Response | null> {
  const access = await canWriteTaskProject(c, id);
  if (access === 'not-found') return error.notFound(c, 'Task', id);
  if (access === 'denied') return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
  return null;
}

function isTerminalStatus(status: unknown): boolean {
  return status === 'done' || status === 'cancelled';
}

function cancelCalendarInBackground(c: TaskCtx, db: TaskDb, calendarEventId: string): void {
  c.executionCtx.waitUntil(
    cancelCalendarEvent(db, calendarEventId).catch((err) =>
      console.error('[app-api/tasks] calendar cancel failed:', err),
    ),
  );
}

function confirmCalendarInBackground(c: TaskCtx, db: TaskDb, calendarEventId: string): void {
  c.executionCtx.waitUntil(
    confirmCalendarEvent(db, calendarEventId)
      .then(() => syncReplanDue(c, db))
      .catch((err) => console.error('[app-api/tasks] calendar confirm failed:', err)),
  );
}

/**
 * Point calendar-api's nightly re-plan at this workspace's next auto-scheduled
 * event (D1 due index), so the sweep never opens idle tenants to look.
 * Call after any write that places or re-places an auto-scheduled event.
 */
function syncReplanDue(c: TaskCtx, db: TaskDb): Promise<void> {
  return syncWorkspaceDue(c.env.SCHEDULE_INDEX, 'calendar_replan', c.get('workspaceId'), () =>
    nextAutoScheduledReplanAt(db),
  );
}

/** Cancel the linked calendar event when a task becomes done/cancelled, re-confirm it when it leaves that state. */
function syncCalendarOnStatusChange(
  c: TaskCtx,
  db: TaskDb,
  calendarEventId: string,
  oldStatus: unknown,
  newStatus: unknown,
): void {
  const wasTerminal = isTerminalStatus(oldStatus);
  const isTerminal = isTerminalStatus(newStatus);
  if (!wasTerminal && isTerminal) {
    cancelCalendarInBackground(c, db, calendarEventId);
  } else if (wasTerminal && !isTerminal) {
    confirmCalendarInBackground(c, db, calendarEventId);
  }
}

/** The assignees of a task row: the multi-assignee list, else the single assignee. */
function assigneeIdsOf(row: { assigneeIds?: string[] | null; assigneeId?: string | null }): string[] {
  if (row.assigneeIds?.length) return row.assigneeIds;
  return row.assigneeId ? [row.assigneeId] : [];
}

/**
 * A repeating task's next occurrence is a task like any other: it gets its
 * calendar slot, the `created` entity event, GitHub sync and an assignment
 * notification for its assignees.
 */
function announceNextOccurrence(c: TaskCtx, db: TaskDb, row: typeof t.$inferSelect): void {
  const userId = c.get('userId');
  c.executionCtx.waitUntil(
    createCalendarEventForTask(db, {
      userId,
      taskId: row.id,
      title: row.title,
      description: row.description ?? null,
      dueDate: row.dueDate ?? null,
      startDate: row.startDate ?? null,
      durationMinutes: row.duration ?? null,
      priority: row.priority ?? null,
    })
      .then(async (eventId) => {
        if (!eventId) return;
        await db.update(t).set({ calendarEventId: eventId }).where(eq(t.id, row.id));
        await syncReplanDue(c, db);
      })
      .catch((err) => console.error('[app-api/tasks] recurrence calendar event failed:', err)),
  );

  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: row.id,
    action: 'created',
    data: taskAnalyticsPayload(row as Record<string, unknown>, { projectId: row.projectId }),
  });
  dispatchGithubOutboundSync(c, { taskId: row.id, projectId: row.projectId, kinds: ['create'] });
  dispatchAssignmentNotifications(c, {
    assigneeIds: assigneeIdsOf(row),
    taskId: row.id,
    taskTitle: row.title,
    projectId: row.projectId,
    taskPriority: row.priority ?? null,
    dueDate: row.dueDate ?? null,
    taskDescription: row.description ?? null,
  });
}

/** Row condition for "this task, not soft-deleted". */
function liveTask(id: string): SQL | undefined {
  return and(eq(t.id, id), isNull(t.deletedAt));
}

/**
 * Writes a status / position change and tells whether THIS write completed the
 * task. A not-done → done change is written as `UPDATE … WHERE status <> 'done'`,
 * so of any number of concurrent requests (a double-clicked toggle, `/status` done
 * sent twice) exactly one gets a row back and owns the completion; the others
 * still write the rest of the change but leave the winner's completion date and
 * stage alone.
 */
async function writeTaskChange(
  db: TaskDb,
  id: string,
  update: Record<string, any>,
  beforeStatus: unknown,
): Promise<boolean> {
  if (!isCompletion(beforeStatus, update.status)) {
    await db.update(t).set(update).where(liveTask(id));
    return false;
  }
  const claimed = await db
    .update(t)
    .set(update)
    .where(and(liveTask(id), sql`${t.status} IS DISTINCT FROM 'done'`))
    .returning({ id: t.id });
  if (claimed.length > 0) return true;
  const rest = { ...update };
  delete rest.status;
  delete rest.completedDate;
  delete rest.stageId;
  await db.update(t).set(rest).where(liveTask(id));
  return false;
}

/**
 * For writes that cannot be one conditional UPDATE (PATCH /:id, which may commit
 * dependency rows in a batch): claims the not-done → done transition up front.
 * True for exactly one of any number of concurrent completions.
 */
async function claimCompletion(db: TaskDb, id: string, beforeStatus: unknown, nextStatus: unknown): Promise<boolean> {
  if (!isCompletion(beforeStatus, nextStatus)) return false;
  const claimed = await db
    .update(t)
    .set({ status: 'done', updatedAt: new Date() })
    .where(and(liveTask(id), sql`${t.status} IS DISTINCT FROM 'done'`))
    .returning({ id: t.id });
  return claimed.length > 0;
}

/**
 * What completing a task owes the rest of the platform: the `project_task.completed`
 * entity event (agent subscriptions and workflow triggers listen for it) and, for
 * a repeating task, its next occurrence. `completed` comes from the write itself
 * (`writeTaskChange` / `claimCompletion`): only the request that actually moved the
 * task from not-done to done owns it, so a repeated `/status` done, a reorder inside
 * the Done column, a toggle with a stale client status or two concurrent completions
 * never fire it (or spawn a second occurrence) twice. `after` is the task as it
 * stands once the change is written. Returns the new occurrence's id, if one was created.
 */
async function handleTaskCompletion(
  c: TaskCtx,
  db: TaskDb,
  completed: boolean,
  after: Record<string, any>,
): Promise<string | null> {
  if (!completed) return null;

  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: after.id,
    action: 'completed',
    data: taskAnalyticsPayload(after, { status: 'done' }),
  });

  if (!after.repeat) return null;
  const next = await createNextOccurrence(db, after as RecurringSource);
  if (!next) return null;
  announceNextOccurrence(c, db, next);
  return next.id;
}

type ReciprocalLink = { id: string; set: { blocks?: string[]; dependsOn?: string[] } };

/**
 * The reciprocal side of a dependency change: a task this one depends on lists it in
 * `blocks`, and a task it blocks lists it in `dependsOn`. Returns the linked rows to
 * write; nothing is written here.
 */
async function reciprocalLinkUpdates(
  db: TaskDb,
  selfId: string,
  diff: { addedDeps: string[]; removedDeps: string[]; addedBlocks: string[]; removedBlocks: string[] },
): Promise<ReciprocalLink[]> {
  const linkedIds = [
    ...new Set([...diff.addedDeps, ...diff.removedDeps, ...diff.addedBlocks, ...diff.removedBlocks]),
  ];
  if (linkedIds.length === 0) return [];
  const rows = await db
    .select({ id: t.id, blocks: t.blocks, dependsOn: t.dependsOn })
    .from(t)
    .where(inArray(t.id, linkedIds));
  const withSelf = (ids: string[]) => [...new Set([...ids, selfId])];
  const withoutSelf = (ids: string[]) => ids.filter((x) => x !== selfId);
  return rows.map((row) => {
    const set: ReciprocalLink['set'] = {};
    const rowBlocks = (row.blocks as string[]) || [];
    const rowDependsOn = (row.dependsOn as string[]) || [];
    if (diff.addedDeps.includes(row.id)) set.blocks = withSelf(rowBlocks);
    if (diff.removedDeps.includes(row.id)) set.blocks = withoutSelf(rowBlocks);
    if (diff.addedBlocks.includes(row.id)) set.dependsOn = withSelf(rowDependsOn);
    if (diff.removedBlocks.includes(row.id)) set.dependsOn = withoutSelf(rowDependsOn);
    return { id: row.id, set };
  });
}

type DependencyFailure = { ok: false; kind: 'not-found' | 'invalid' | 'forbidden'; message: string };
type DependencyPlan = {
  ok: true;
  /** The task row as it was before the change. */
  task: Record<string, unknown>;
  dependsOn: string[];
  blocks: string[];
  reciprocal: ReciprocalLink[];
};

const LINKED_TASK_DENIED = "You are not a member of a linked task's project";

/**
 * Every task newly added to dependsOn / blocks must exist, not be deleted, not be the
 * task itself, and live in a project the caller can access (personal tasks, with a
 * null projectId, are fine). Removing links is never checked.
 */
async function checkAddedLinks(
  c: TaskCtx,
  db: TaskDb,
  selfId: string,
  addedIds: string[],
): Promise<DependencyFailure | null> {
  if (addedIds.length === 0) return null;
  if (addedIds.includes(selfId)) {
    return { ok: false, kind: 'invalid', message: 'A task cannot depend on or block itself' };
  }
  const rows = await db
    .select({ id: t.id, projectId: t.projectId, deletedAt: t.deletedAt })
    .from(t)
    .where(inArray(t.id, addedIds));
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const linkedId of addedIds) {
    const row = found.get(linkedId);
    if (!row || row.deletedAt) {
      return { ok: false, kind: 'invalid', message: `Linked task ${linkedId} not found` };
    }
  }
  const accessible = await accessibleProjectIds(c);
  if (accessible !== null && rows.some((row) => row.projectId && !accessible.includes(row.projectId))) {
    return { ok: false, kind: 'forbidden', message: LINKED_TASK_DENIED };
  }
  return null;
}

/**
 * Shared by PUT /:id/dependencies and PATCH /:id: validates the newly added links
 * (existence, access, cycles) and works out the reciprocal rows. Writes nothing;
 * `commitDependencyUpdate` applies the plan.
 */
async function planDependencyUpdate(
  c: TaskCtx,
  db: TaskDb,
  id: string,
  input: { dependsOn?: string[]; blocks?: string[] },
): Promise<DependencyPlan | DependencyFailure> {
  const [currentTask] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  if (!currentTask) return { ok: false, kind: 'not-found', message: `Task ${id} not found` };

  const oldDependsOn: string[] = (currentTask.dependsOn as string[]) || [];
  const oldBlocks: string[] = (currentTask.blocks as string[]) || [];
  const newDependsOn = input.dependsOn ? [...new Set(input.dependsOn)] : oldDependsOn;
  const newBlocks = input.blocks ? [...new Set(input.blocks)] : oldBlocks;

  const addedDeps = newDependsOn.filter((dep) => !oldDependsOn.includes(dep));
  const removedDeps = oldDependsOn.filter((dep) => !newDependsOn.includes(dep));
  const addedBlocks = newBlocks.filter((b) => !oldBlocks.includes(b));
  const removedBlocks = oldBlocks.filter((b) => !newBlocks.includes(b));

  const invalidLink = await checkAddedLinks(c, db, id, [...addedDeps, ...addedBlocks]);
  if (invalidLink) return invalidLink;

  // A new dependsOn edge closes a cycle when it leads back to this task. A new blocks
  // edge appends this task to the blocked task's dependsOn, so it closes a cycle when
  // the blocked task is reachable from this task's (new) dependsOn.
  const cyclic =
    (addedDeps.length > 0 && (await detectCycle(db, id, addedDeps))) ||
    (await anyAsync(addedBlocks, (blockedId) => detectCycle(db, blockedId, newDependsOn)));
  if (cyclic) return { ok: false, kind: 'invalid', message: 'Circular dependency detected' };

  const reciprocal = await reciprocalLinkUpdates(db, id, {
    addedDeps,
    removedDeps,
    addedBlocks,
    removedBlocks,
  });

  return {
    ok: true,
    task: currentTask as Record<string, unknown>,
    dependsOn: newDependsOn,
    blocks: newBlocks,
    reciprocal,
  };
}

/**
 * Write the task's own row (its dependency lists plus any other column changes) and
 * every reciprocal row as one unit, so a failure leaves no one-sided link behind.
 */
async function commitDependencyUpdate(
  db: TaskDb,
  id: string,
  plan: DependencyPlan,
  columns: Record<string, any> = {},
): Promise<void> {
  const now = new Date();
  await atomically(db, (handle) => [
    ...plan.reciprocal.map((link) =>
      handle.update(t).set({ ...link.set, updatedAt: now }).where(eq(t.id, link.id)),
    ),
    handle
      .update(t)
      .set({ ...columns, dependsOn: plan.dependsOn, blocks: plan.blocks, updatedAt: now })
      .where(and(eq(t.id, id), isNull(t.deletedAt))),
  ]);
}

async function anyAsync<T>(items: T[], test: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) {
    if (await test(item)) return true;
  }
  return false;
}

function dependencyFailureResponse(c: TaskCtx, id: string, failure: DependencyFailure): Response {
  if (failure.kind === 'not-found') return error.notFound(c, 'Task', id);
  if (failure.kind === 'forbidden') return error.forbidden(c, failure.message);
  return error.badRequest(c, failure.message);
}

/** Fields of a position update that are echoed back in the event payload and the response. */
function positionEcho(data: { position?: number; status?: string }) {
  return {
    ...(data.position !== undefined && { position: data.position }),
    ...(data.status && { status: data.status }),
  };
}

function buildPositionUpdate(data: {
  position?: number;
  boardPosition?: number;
  status?: string;
}): Record<string, any> {
  const updateData: Record<string, any> = { updatedAt: new Date() };
  if (data.position !== undefined) updateData.position = data.position;
  if (data.boardPosition !== undefined) updateData.boardPosition = data.boardPosition;
  if (data.status) {
    updateData.status = data.status;
    if (data.status === 'done') updateData.completedDate = new Date();
  }
  return updateData;
}

// --- PATCH /:id helpers ------------------------------------------------------

/** Keep `assigneeId` and `assigneeIds` consistent with whichever one the caller sent. */
function syncAssigneeFields(update: Record<string, any>, data: Record<string, any>): void {
  if (data.assigneeIds !== undefined) {
    const ids = (data.assigneeIds as string[]) || [];
    update.assigneeIds = ids.length > 0 ? ids : null;
    update.assigneeId = ids[0] || null;
  } else if (data.assigneeId !== undefined) {
    update.assigneeIds = data.assigneeId ? [data.assigneeId] : null;
  }
}

/**
 * The only `tasks` columns a PATCH body may write. Listed here as well as in
 * `updateTaskSchema` so a future schema addition cannot silently become a column
 * write. `assigneeIds` goes through `syncAssigneeFields`; `projectId`, `dependsOn`
 * and `blocks` have their own handling in the PATCH handler.
 */
const PATCHABLE_TASK_COLUMNS = [
  'title',
  'description',
  'status',
  'priority',
  'type',
  'stageId',
  'sprintId',
  'milestoneId',
  'parentTaskId',
  'assigneeId',
  'customerId',
  'contactId',
  'personId',
  'startDate',
  'dueDate',
  'estimatedHours',
  'duration',
  'storyPoints',
  'labels',
  'tags',
  'isBillable',
  'repeat',
  'customFields',
] as const;

/** Copy the allow-listed body fields (date strings become Dates) and sync the assignee columns. */
function buildTaskUpdate(data: Record<string, any>): Record<string, any> {
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of PATCHABLE_TASK_COLUMNS) {
    const v = data[k];
    if (v === undefined) continue;
    update[k] = (k === 'startDate' || k === 'dueDate') && v ? new Date(v as string) : v;
  }
  syncAssigneeFields(update, data);
  return update;
}

/**
 * Pre-write checks on a PATCH's `projectId` / `parentTaskId`. A project change goes
 * through POST /:id/move (access check + rollout flag), so a PATCH may only repeat
 * the current project. A changed parent must be a live task of the same project,
 * and a changed sprint / milestone / stage must belong to that project too.
 */
async function validateTaskRelations(
  db: TaskDb,
  existing: any,
  id: string,
  data: Record<string, any>,
): Promise<string | null> {
  const currentProjectId = existing.projectId ?? null;
  if (data.projectId !== undefined && (data.projectId ?? null) !== currentProjectId) {
    return 'projectId cannot be changed with PATCH; use POST /api/tasks/:id/move';
  }
  // Sprint / milestone / stage must belong to the task's own project (a stage
  // also drives the status, so another project's would leak its systemStatus).
  const { sprintId, milestoneId, stageId } = changedTaskReferences(existing, data);
  const referenceError = await findInvalidTaskReference(db, currentProjectId, {
    sprintId,
    milestoneId,
    stageId,
  });
  if (referenceError) return referenceError;

  const parentId = data.parentTaskId;
  if (parentId === undefined || parentId === null || parentId === existing.parentTaskId) return null;
  if (parentId === id) return 'A task cannot be its own parent';
  const [parent] = await db
    .select({ projectId: t.projectId, deletedAt: t.deletedAt })
    .from(t)
    .where(eq(t.id, parentId))
    .limit(1);
  if (!parent || parent.deletedAt) return `Parent task ${parentId} not found`;
  if ((parent.projectId ?? null) !== currentProjectId) {
    return 'Parent task must belong to the same project';
  }
  if (await isDescendantOf(db, parentId, id)) {
    return 'Cannot move a task under itself or one of its subtasks';
  }
  return null;
}

/**
 * True when `candidateId` is `ancestorId` or sits anywhere below it. Walks up the
 * candidate's parent chain (a task has one parent, so this is a single path) and
 * stops at a root, a repeated id (pre-existing cycle) or a generous depth bound.
 */
async function isDescendantOf(db: TaskDb, candidateId: string, ancestorId: string): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | null = candidateId;
  for (let depth = 0; cursor && depth < 100; depth++) {
    if (cursor === ancestorId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const [row] = await db
      .select({ parentTaskId: t.parentTaskId })
      .from(t)
      .where(eq(t.id, cursor))
      .limit(1);
    cursor = (row?.parentTaskId as string | null | undefined) ?? null;
  }
  return false;
}

function resolveUpdatedDate(incoming: unknown, current: Date | null): Date | null {
  if (incoming === undefined) return current;
  return incoming ? new Date(incoming as string) : null;
}

/** Calendar sync after a PATCH: create the event if missing, else reschedule / cancel / confirm as needed. */
function syncCalendarAfterUpdate(
  c: TaskCtx,
  db: TaskDb,
  args: {
    existing: any;
    data: Record<string, any>;
    resolvedStatus: unknown;
    userId: string;
    id: string;
  },
): void {
  const { existing, data, resolvedStatus, userId, id } = args;
  const calendarEventId = existing.calendarEventId;
  const eventFields = {
    userId,
    taskId: id,
    title: (data.title as string) || existing.title,
    description:
      data.description !== undefined
        ? (data.description as string | null)
        : existing.description,
    dueDate: resolveUpdatedDate(data.dueDate, existing.dueDate),
    startDate: resolveUpdatedDate(data.startDate, existing.startDate),
    durationMinutes:
      data.duration !== undefined ? (data.duration as number | null) : existing.duration,
  };

  if (!calendarEventId) {
    c.executionCtx.waitUntil(
      createCalendarEventForTask(db, {
        ...eventFields,
        priority: (data.priority as string | null) ?? existing.priority,
      })
        .then((eventId) => db.update(t).set({ calendarEventId: eventId }).where(eq(t.id, id)))
        .then(() => syncReplanDue(c, db))
        .catch((err) => console.error('[app-api/tasks] calendar event creation failed:', err)),
    );
    return;
  }

  const reschedule = (priority: string | null, failureLabel: string) =>
    c.executionCtx.waitUntil(
      rescheduleCalendarEvent(db, { ...eventFields, calendarEventId, priority })
        .then((newEventId) =>
          db.update(t).set({ calendarEventId: newEventId }).where(eq(t.id, id)),
        )
        .then(() => syncReplanDue(c, db))
        .catch((err) => console.error(`[app-api/tasks] ${failureLabel} failed:`, err)),
    );

  const datesChanged = data.dueDate !== undefined || data.startDate !== undefined;
  if (datesChanged || data.title !== undefined || data.duration !== undefined) {
    reschedule((data.priority as string | null) ?? existing.priority, 'calendar reschedule');
  }

  // Status → done/cancelled: cancel calendar event
  syncCalendarOnStatusChange(c, db, calendarEventId, existing.status, resolvedStatus);

  // Priority changed without date changes → reschedule
  const priorityChanged = data.priority !== undefined && data.priority !== existing.priority;
  if (priorityChanged && !datesChanged) {
    reschedule(data.priority as string, 'calendar priority reschedule');
  }
}

/** Assignees present after the update that were not on the task before. */
function newlyAddedAssignees(existing: any, update: Record<string, any>): string[] {
  const oldIds: string[] =
    existing.assigneeIds || (existing.assigneeId ? [existing.assigneeId] : []);
  const newIds: string[] =
    update.assigneeIds || (update.assigneeId ? [update.assigneeId] : oldIds);
  return newIds.filter((aid) => !oldIds.includes(aid));
}

function githubKindsForUpdate(
  data: Record<string, any>,
  resolvedStatus: unknown,
  existingStatus: unknown,
): GithubOutboundKind[] {
  const kinds: GithubOutboundKind[] = [];
  if (data.title !== undefined || data.description !== undefined || data.labels !== undefined) {
    kinds.push('update');
  }
  if (resolvedStatus !== existingStatus) kinds.push('status');
  return kinds;
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
  crmLinked: queryBoolean.optional(),
  parentTaskId: z.string().optional(),
  // Filters
  status: z.string().optional(),
  priority: z.string().optional(),
  type: z.string().optional(),
  assigneeId: z.string().optional(),
  myTasks: queryBoolean.optional(),
  search: z.string().optional(),
  labelIds: taskCsvStringArray,
  tags: taskCsvStringArray,
  dueDateBucket: dueDateBucketEnum,
  // Negated ("is not") counterparts of the filters above
  excludeStatus: taskCsvStringArray,
  excludePriority: taskCsvStringArray,
  excludeAssigneeId: z.string().optional(),
  excludeLabelIds: taskCsvStringArray,
  excludeDueDateBucket: dueDateBucketEnum,
  dueDateFrom: z.string().optional(),
  dueDateTo: z.string().optional(),
  // Sort
  sortField: taskSortFieldEnum,
  sortDirection: z.enum(['asc', 'desc']).optional().default('asc'),
  // Subtree
  includeSubtasks: queryBoolean.default('false'),
  // Enrichment
  enrich: queryBoolean.default('true'),
});

type ListQuery = z.infer<typeof listQuerySchema>;
/**
 * Row-level: a projectId filter must name a project the caller can access;
 * with none, limit project tasks to accessible projects.
 * KNOWN-DEFERRED: non-project tasks (null projectId — personal WeldConnect +
 * CRM-linked) are NOT owner-scoped here. `tasks:*` is a flat workspace grant
 * with no `tasks:scope:all`, and there is no per-user (assignee/creator) gate
 * yet, so a `tasks:read` holder can still see another user's personal task.
 * Gating this needs a product decision (assignee/creator vs CRM-shared) —
 * tracked as a deferred item alongside the MEDIUM findings.
 */
async function resolveProjectScope(
  c: TaskCtx,
  projectId: string | undefined,
): Promise<{ denied: boolean; condition: SQL | undefined }> {
  if (projectId) {
    return { denied: !(await canAccessProject(c, projectId)), condition: undefined };
  }
  const accessible = await accessibleProjectIds(c);
  if (accessible === null) return { denied: false, condition: undefined };
  return {
    denied: false,
    condition: or(isNull(t.projectId), inArray(t.projectId, accessible.length ? accessible : [''])),
  };
}

function taskScopeFilters(q: ListQuery, projectScope: SQL | undefined): SQL[] {
  const filters: SQL[] = [];
  if (q.projectId) filters.push(eq(t.projectId, q.projectId));
  if (projectScope) filters.push(projectScope);
  if (q.sprintId) filters.push(eq(t.sprintId, q.sprintId));
  if (q.milestoneId) filters.push(eq(t.milestoneId, q.milestoneId));
  if (q.customerId) filters.push(eq(t.customerId, q.customerId));
  if (q.contactId) filters.push(eq(t.contactId, q.contactId));
  if (q.personId) filters.push(eq((t as any).personId, q.personId));

  // CRM-linked only: at least one of the company/person link columns is set.
  if (q.crmLinked) {
    filters.push(
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
    filters.push(eq(t.parentTaskId, q.parentTaskId));
  } else if (q.projectId) {
    filters.push(isNull(t.parentTaskId));
  }
  return filters;
}

function taskValueFilters(q: ListQuery, userId: string | undefined): SQL[] {
  const filters: SQL[] = [];
  // Status filters match every stored spelling, so `review` also finds rows
  // still carrying the legacy `in_review`.
  if (q.status) filters.push(inArray(t.status, taskStatusAliases(q.status)));
  if (q.priority) filters.push(eq(t.priority, q.priority));
  if (q.type) filters.push(eq(t.type, q.type));
  // "is not" filters (status/priority are NOT NULL columns, so plain NOT IN is safe).
  if (q.excludeStatus) filters.push(notInArray(t.status, q.excludeStatus.flatMap(taskStatusAliases)));
  if (q.excludePriority) filters.push(notInArray(t.priority, q.excludePriority));
  if (q.excludeAssigneeId) {
    filters.push(
      sql`NOT (coalesce(${t.assigneeId} = ${q.excludeAssigneeId}, false) OR coalesce(${t.assigneeIds}::jsonb @> ${JSON.stringify([q.excludeAssigneeId])}::jsonb, false))`,
    );
  }

  // Assignee: myTasks shorthand takes precedence over explicit assigneeId
  const effectiveAssigneeId = q.myTasks ? userId : q.assigneeId;
  if (effectiveAssigneeId) {
    filters.push(
      or(
        eq(t.assigneeId, effectiveAssigneeId),
        sql`${t.assigneeIds}::jsonb @> ${JSON.stringify([effectiveAssigneeId])}::jsonb`,
      )!,
    );
  }
  return filters;
}

function taskSearchFilters(q: ListQuery): SQL[] {
  const filters: SQL[] = [];
  if (q.search) {
    const term = containsPattern(q.search);
    const searchClauses = [
      ilike(t.title, term),
      ilike(t.description, term),
      ilike((t as any).key, term),
    ];
    // Let users find a task by its number: "TASK-1042", "#1042", or "1042".
    const numberMatch = q.search.trim().replace(/^#/, '').replace(/^task-/i, '');
    if (/^\d+$/.test(numberMatch)) {
      searchClauses.push(eq(t.number, Number(numberMatch)));
    }
    filters.push(or(...searchClauses)!);
  }

  if (q.excludeLabelIds && q.excludeLabelIds.length > 0) {
    filters.push(
      sql`NOT coalesce(${t.labels} ?| array[${sql.join(
        q.excludeLabelIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[], false)`,
    );
  }

  if (q.labelIds && q.labelIds.length > 0) {
    filters.push(
      sql`${t.labels} ?| array[${sql.join(
        q.labelIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]`,
    );
  }
  return filters;
}

function taskDueDateFilters(q: ListQuery, bounds: DayBounds | undefined): SQL[] {
  const filters: SQL[] = [];
  if (q.dueDateBucket) filters.push(dueDateBucketCondition(q.dueDateBucket, t.dueDate, bounds));
  if (q.excludeDueDateBucket) {
    // coalesce: a NULL due date makes most bucket windows NULL, i.e. "not in it".
    filters.push(sql`coalesce(NOT (${dueDateBucketCondition(q.excludeDueDateBucket, t.dueDate, bounds)}), true)`);
  }
  if (q.dueDateFrom) filters.push(gte(t.dueDate, new Date(q.dueDateFrom)));
  if (q.dueDateTo) filters.push(lt(t.dueDate, new Date(q.dueDateTo)));
  return filters;
}

/**
 * Cursor support: the cursor is the id of the last row of the previous page;
 * continue from its position in the list's sort order. Undefined when there is
 * no cursor or its row no longer exists.
 */
async function resolveTaskCursor(
  db: TaskDb,
  q: ListQuery,
  sortColumn: ReturnType<typeof resolveTaskSortColumn>,
): Promise<SQL | undefined> {
  if (!q.cursor) return undefined;
  const [cur] = await db
    .select({ id: t.id, sortValue: sortColumn })
    .from(t)
    .where(eq(t.id, q.cursor))
    .limit(1);
  return cur ? taskCursorCondition(sortColumn, q.sortDirection, cur, t) : undefined;
}

function paginateTaskRows(
  rows: any[],
  q: ListQuery,
  useCursor: boolean,
  offset: number,
  totalCount: number,
): { data: any[]; paginationMeta: ReturnType<typeof cursorPagination> } {
  if (useCursor) {
    const hasMore = rows.length > q.limit;
    const data = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data.at(-1).id : null;
    return { data, paginationMeta: cursorPagination(totalCount, hasMore, nextCursor) };
  }
  const hasMore = offset + rows.length < totalCount;
  const nextCursor = hasMore && rows.length > 0 ? rows.at(-1).id : null;
  return { data: rows, paginationMeta: cursorPagination(totalCount, hasMore, nextCursor) };
}

/**
 * Full descendant tree (BFS over parentTaskId, bounded by MAX_SUBTASK_DEPTH), enriched + hydrated in one batch.
 * `projectId` narrows the walk to one project; without it the roots may span projects (My Tasks).
 */
async function loadEnrichedDescendants(db: TaskDb, projectId: string | null, roots: any[]): Promise<any[]> {
  let frontier: string[] = roots.map((row: any) => row.id);
  const allDescendants: any[] = [];
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
    const children = await db
      .select()
      .from(t)
      .where(
        and(
          projectId ? eq(t.projectId, projectId) : undefined,
          inArray(t.parentTaskId, frontier),
          isNull(t.deletedAt),
        ),
      )
      // Oldest first, like the task panel's subtask list (and like a subtask
      // appended in the client), so both surfaces agree.
      .orderBy(asc(t.position), asc(t.createdAt), asc(t.id));
    // A root can itself sit under another root (My Tasks lists my subtasks
    // as rows of their own), so the same child can be reached twice.
    const fresh = children.filter((child: any) => !seen.has(child.id));
    if (fresh.length === 0) break;
    for (const child of fresh) seen.add(child.id);
    allDescendants.push(...fresh);
    frontier = fresh.map((child: any) => child.id);
  }

  // Phase 3: hydrate the whole descendant set in one batch too.
  if (allDescendants.length === 0) return [];
  return hydrateCustomFields(db, 'task', await enrichTasksWithAssignees(db, allDescendants));
}

function attachSubtaskTree(roots: any[], descendants: any[]): void {
  const childrenByParent = new Map<string, any[]>();
  for (const row of descendants) {
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
  for (const top of roots) attach(top);
}

/**
 * Attach every root's full subtask tree as `children` (+ subtaskCount /
 * completedSubtaskCount on each node). Used by My Tasks, whose roots span
 * projects, so the walk is not narrowed to one project.
 */
export async function attachSubtaskTreeAcrossProjects(db: TaskDb, roots: any[]): Promise<void> {
  if (roots.length === 0) return;
  const descendants = await loadEnrichedDescendants(db, null, roots);
  attachSubtaskTree(roots, descendants);
}

async function attachSubtaskCounts(db: TaskDb, tasks: any[]): Promise<void> {
  const parentIds = tasks.map((row: any) => row.id);
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
  for (const task of tasks) {
    const counts = countMap.get(task.id);
    task.subtaskCount = counts?.total || 0;
    task.completedSubtaskCount = counts?.completed || 0;
  }
}

/**
 * Subtask tree / counts. Returns the descendant rows delivered in the same
 * payload (includeSubtasks tree) so they get attachment counts too.
 */
async function attachSubtaskData(db: TaskDb, q: ListQuery, enriched: any[]): Promise<any[]> {
  if (enriched.length === 0) return [];
  if (q.includeSubtasks && q.projectId) {
    const descendants = await loadEnrichedDescendants(db, q.projectId, enriched);
    attachSubtaskTree(enriched, descendants);
    return descendants;
  }
  await attachSubtaskCounts(db, enriched);
  return [];
}

/**
 * Attachment counts — ONE batched query over the whole returned payload
 * (top-level page + any includeSubtasks descendants), from the `files`
 * table (entityType='task'), not the custom_fields blob. Skipped when empty.
 */
async function attachAttachmentCounts(db: TaskDb, targets: any[]): Promise<void> {
  if (targets.length === 0) return;
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
          targets.map((row) => row.id),
        ),
        isNull(schema.files.deletedAt),
      ),
    )
    .groupBy(schema.files.entityId);

  const attachmentCountMap = new Map(
    attachmentCounts.map((r: any) => [r.entityId, r.n]),
  );
  for (const task of targets) {
    task.attachmentsCount = attachmentCountMap.get(task.id) ?? 0;
  }
}

app.get('/', requirePermission('tasks:read'), zValidator('query', listQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');

  const scope = await resolveProjectScope(c, q.projectId);
  if (scope.denied) return error.forbidden(c, PROJECT_MEMBER_DENIED);

  // Due-date buckets cut the day in the workspace time zone, not at UTC midnight.
  const dayBounds =
    q.dueDateBucket || q.excludeDueDateBucket ? await workspaceDayBounds(db) : undefined;

  const filters: SQL[] = [
    isNull(t.deletedAt),
    taskInLiveProject(t.projectId),
    ...taskScopeFilters(q, scope.condition),
    ...taskValueFilters(q, userId),
    ...taskSearchFilters(q),
    ...taskDueDateFilters(q, dayBounds),
  ];

  // Sort
  const sortDir = q.sortDirection === 'desc' ? desc : asc;
  const sortColumn = resolveTaskSortColumn(q.sortField, t);

  const cursorCondition = await resolveTaskCursor(db, q, sortColumn);
  const conditions = cursorCondition ? [...filters, cursorCondition] : filters;

  // Count (without cursor condition)
  const countWhere = and(...filters);
  const where = and(...conditions);

  try {
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
        // Cursor mode keysets on (sort value, id desc); offset mode (a project list) breaks ties
        // oldest-first, the order subtasks use, so equal positions never shuffle between pages.
        .orderBy(sortDir(sortColumn), ...(useCursor ? [desc(t.id)] : [asc(t.createdAt), asc(t.id)]))
        .limit(fetchLimit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(countWhere),
    ]);

    const totalCount = Number(countRes[0]?.count ?? 0);
    const { data, paginationMeta } = paginateTaskRows(rows, q, useCursor, offset, totalCount);

    // Enrichment
    const assigneeEnriched = q.enrich ? await enrichTasksWithAssignees(db, data) : data;
    // Phase 3: customFields comes from the typed values table, not the blob.
    // Batched — two extra queries for the whole page, regardless of page size.
    const enriched = await hydrateCustomFields(db, 'task', assigneeEnriched);

    const descendantRows = await attachSubtaskData(db, q, enriched);
    await attachAttachmentCounts(db, [...enriched, ...descendantRows]);

    return list(c, enriched, paginationMeta);
  } catch (err) {
    console.error('[app-api/tasks] list failed:', err);
    return error.internal(c, 'Failed to list tasks');
  }
});

// ============================================================================
// PATCH /reorder — Batch reorder tasks by position
// MUST be registered BEFORE /:id to avoid route collision.
//
// Ordering convention: `position` ascending is the display order (the list
// default, subtasks and descendants all sort that way), and `taskIds` is the
// desired order, first = top. The tasks swap into each other's existing slots
// rather than being renumbered 1..n: a partial list (one loaded page, or only
// the caller's own tasks in a project, as My Tasks sends) reorders among itself
// and never lands on a position another task in the project holds.
// ============================================================================

/**
 * Positions for a reorder: the tasks' current positions, sorted ascending, are
 * handed out in the requested order. Ids that match no row are skipped, and a
 * run of equal positions (rows that were never ranked) is spread out so every
 * task ends up strictly after the one above it.
 */
export function reorderedPositions(
  rows: ReadonlyArray<{ id: string; position: number }>,
  orderedIds: readonly string[],
): Map<string, number> {
  const known = new Set(rows.map((row) => row.id));
  const slots = rows.map((row) => row.position).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  }
  const result = new Map<string, number>();
  for (const id of orderedIds) {
    if (!known.has(id) || result.has(id)) continue;
    result.set(id, slots[result.size]);
  }
  return result;
}

/**
 * `reorderedPositions` per project. A reorder without a `projectId` (My Tasks) can
 * span several projects, and positions only mean something inside one: each project's
 * tasks (personal tasks, with no project, form a group of their own) reuse that
 * group's slots, so one project's positions never land on another's tasks.
 */
export function reorderedPositionsByProject(
  rows: ReadonlyArray<{ id: string; projectId: string | null; position: number }>,
  orderedIds: readonly string[],
): Map<string, number> {
  const groups = new Map<string | null, { id: string; position: number }[]>();
  for (const row of rows) {
    const group = groups.get(row.projectId) ?? [];
    group.push(row);
    groups.set(row.projectId, group);
  }
  const result = new Map<string, number>();
  for (const group of groups.values()) {
    for (const [id, position] of reorderedPositions(group, orderedIds)) result.set(id, position);
  }
  return result;
}

app.patch(
  '/reorder',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ taskIds: z.array(z.string()).min(1) })),
  async (c) => {
    const db = c.get('tenantDb');
    const { taskIds } = c.req.valid('json');
    const q = c.req.query();
    const projectId = q.projectId;
    if (projectId && !(await canWriteProject(c, projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }

    try {
      // Guard EVERY task, not just the optional projectId filter — otherwise a
      // caller could reorder arbitrary tasks by id when projectId is omitted.
      // One read for the rows, one access check per distinct project.
      const rows = await db
        .select({ id: t.id, projectId: t.projectId, position: t.position })
        .from(t)
        .where(
          and(
            inArray(t.id, taskIds),
            isNull(t.deletedAt),
            projectId ? eq(t.projectId, projectId) : undefined,
          ),
        );
      const projectIds = [...new Set(rows.map((row) => row.projectId).filter((p): p is string => !!p))];
      for (const rowProjectId of projectIds) {
        if (!(await canWriteProject(c, rowProjectId))) {
          return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
        }
      }

      const positions = reorderedPositionsByProject(rows, taskIds);
      const now = new Date();
      if (positions.size > 0) {
        await atomically(db, (handle) =>
          [...positions].map(([taskId, position]) =>
            handle.update(t).set({ position, updatedAt: now }).where(eq(t.id, taskId)),
          ),
        );
      }
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
    if (!(await canWriteProject(c, projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const data = c.req.valid('json') as Record<string, any>;
    try {
      const referenceError = await findInvalidTaskReference(db, projectId, data);
      if (referenceError) return error.badRequest(c, referenceError);
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
          await syncReplanDue(c, db);
        }
      } catch (calErr) {
        console.error('[app-api/tasks] calendar auto-schedule failed:', calErr);
      }

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: row.id,
        action: 'created',
        data: taskAnalyticsPayload(row as Record<string, unknown>, { projectId }),
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
    const acc = await canWriteTaskProject(c, id);
    if (acc === 'not-found') return error.notFound(c, 'Task', id);
    if (acc === 'denied') return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
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
  const acc = await canWriteTaskProject(c, id);
  if (acc === 'not-found') return error.notFound(c, 'Task', id);
  if (acc === 'denied') return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
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
    if (projectId && !(await canWriteProject(c, projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const referenceError = await findInvalidTaskReference(db, projectId, data);
    if (referenceError) return error.badRequest(c, referenceError);
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
        await syncReplanDue(c, db);
      }
    } catch (calErr) {
      console.error('[app-api/tasks] calendar auto-schedule failed:', calErr);
    }

    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: row.id,
      action: 'created',
      data: taskAnalyticsPayload(row as Record<string, unknown>, { projectId }),
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
      status: taskStatusSchema.optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const denied = await guardTaskWrite(c, id);
    if (denied) return denied;
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
      const stageId = await stageForStatus(db, currentTask, newStatus);
      if (stageId) updateData.stageId = stageId;

      const completed = await writeTaskChange(db, id, updateData, currentTask.status);

      // Calendar sync
      const calendarEventId = (currentTask as any).calendarEventId;
      if (calendarEventId) {
        if (isTerminalStatus(newStatus)) {
          cancelCalendarInBackground(c, db, calendarEventId);
        } else if (isTerminalStatus((currentTask as any).status)) {
          confirmCalendarInBackground(c, db, calendarEventId);
        }
      }

      // Completion: `completed` event + the next occurrence of a repeating task
      const nextTaskId = await handleTaskCompletion(c, db, completed, {
        ...currentTask,
        ...updateData,
      });

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: taskAnalyticsPayload(currentTask as Record<string, unknown>, { status: newStatus }),
        changes: buildTaskChanges(currentTask as Record<string, unknown>, updateData),
      });

      if (newStatus !== (currentTask as any).status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: (currentTask as any).projectId,
          kinds: ['status'],
        });
      }

      return success(c, {
        id,
        status: newStatus,
        stageId: stageId ?? currentTask.stageId,
        ...(nextTaskId && { nextTaskId }),
      });
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
  zValidator('json', z.object({ status: taskStatusSchema })),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const denied = await guardTaskWrite(c, id);
    if (denied) return denied;
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
      const stageId = await stageForStatus(db, currentTask, status);
      if (stageId) updateData.stageId = stageId;

      const completed = await writeTaskChange(db, id, updateData, currentTask.status);

      const calendarEventId = (currentTask as any).calendarEventId;
      if (calendarEventId) {
        syncCalendarOnStatusChange(c, db, calendarEventId, (currentTask as any).status, status);
      }

      const nextTaskId = await handleTaskCompletion(c, db, completed, {
        ...currentTask,
        ...updateData,
      });

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: taskAnalyticsPayload(currentTask as Record<string, unknown>, { status }),
        changes: buildTaskChanges(currentTask as Record<string, unknown>, updateData),
      });

      if (status !== (currentTask as any).status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: (currentTask as any).projectId,
          kinds: ['status'],
        });
      }

      return success(c, {
        id,
        status,
        stageId: stageId ?? currentTask.stageId,
        ...(nextTaskId && { nextTaskId }),
      });
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
      status: taskStatusSchema.optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const denied = await guardTaskWrite(c, id);
    if (denied) return denied;
    const data = c.req.valid('json');

    try {
      const [task] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!task) return error.notFound(c, 'Task', id);
      const currentTask: any = task;

      const positionUpdate = buildPositionUpdate(data);
      if (data.status) {
        const stageId = await stageForStatus(db, task, data.status);
        if (stageId) positionUpdate.stageId = stageId;
      }
      const completed = await writeTaskChange(db, id, positionUpdate, currentTask.status);

      // Calendar sync on status change
      if (currentTask?.calendarEventId && data.status) {
        syncCalendarOnStatusChange(c, db, currentTask.calendarEventId, currentTask.status, data.status);
      }

      const nextTaskId = await handleTaskCompletion(c, db, completed, {
        ...currentTask,
        ...positionUpdate,
      });

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: taskAnalyticsPayload(currentTask as Record<string, unknown>, positionEcho(data)),
        changes: buildTaskChanges(currentTask as Record<string, unknown>, { status: data.status }),
      });

      if (data.status && data.status !== currentTask.status) {
        dispatchGithubOutboundSync(c, {
          taskId: id,
          projectId: currentTask.projectId,
          kinds: ['status'],
        });
      }

      return success(c, {
        id,
        ...positionEcho(data),
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
    const denied = await guardTaskWrite(c, id);
    if (denied) return denied;
    const data = c.req.valid('json');

    try {
      const plan = await planDependencyUpdate(c, db, id, data);
      if (!plan.ok) return dependencyFailureResponse(c, id, plan);
      await commitDependencyUpdate(db, id, plan);

      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: taskAnalyticsPayload(plan.task),
      });

      return success(c, { id, dependsOn: plan.dependsOn, blocks: plan.blocks });
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
// project's defaults. Subtasks keep their parent (it moves with them); the moved
// root is detached from its old parent (parentTaskId = null).
// ============================================================================

/**
 * The destination project's default pipeline stage (lowest position) drives the
 * reset stage + system status of a moved task. Falls back to a plain "todo"
 * backlog when the project has no pipeline stages.
 */
async function destinationDefaults(
  db: TaskDb,
  destProjectId: string,
): Promise<{ resetStageId: string | null; resetStatus: string }> {
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
  return { resetStageId: defaultStage?.id ?? null, resetStatus: defaultStage?.systemStatus ?? 'todo' };
}

/** The full descendant subtree of a task (BFS over parentTaskId, bounded by MAX_SUBTASK_DEPTH). */
async function collectDescendants(db: TaskDb, rootId: string): Promise<{ id: string; title: string }[]> {
  const descendants: { id: string; title: string }[] = [];
  const seenIds = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
    const children = await db
      .select({ id: t.id, title: t.title })
      .from(t)
      .where(and(inArray(t.parentTaskId, frontier), isNull(t.deletedAt)));
    const fresh = children.filter((row) => !seenIds.has(row.id));
    if (fresh.length === 0) break;
    for (const row of fresh) seenIds.add(row.id);
    descendants.push(...fresh);
    frontier = fresh.map((row) => row.id);
  }
  return descendants;
}

app.post(
  '/:id/move',
  requirePermission('tasks:update'),
  zValidator('json', moveTaskSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { projectId: destProjectId } = c.req.valid('json');
    // Must be able to act on both the task's SOURCE project and the DESTINATION.
    const _taskAccess = await canWriteTaskProject(c, id);
    if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
    if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
    if (destProjectId && !(await canWriteProject(c, destProjectId))) {
      return error.forbidden(c, 'You do not have write access to the destination project');
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

      const { resetStageId, resetStatus } = await destinationDefaults(db, destProjectId);

      // Subtasks travel with their parent.
      const descendants = await collectDescendants(db, id);
      const descendantIds = descendants.map((row) => row.id);

      // Next board position at the bottom of the destination project's list.
      const [positionRow] = await db
        .select({ maxPosition: sql<number>`coalesce(max(${t.position}), 0)::int` })
        .from(t)
        .where(and(eq(t.projectId, destProjectId), isNull(t.deletedAt)));
      const basePosition = (positionRow?.maxPosition || 0) + 1;

      const now = new Date();
      const allIds = [id, ...descendantIds];

      // Reset & move each task. Subtasks keep their parent (it moves with them),
      // but the moved root is detached: its old parent stays behind in the source
      // project, and a task whose parent is elsewhere never shows in the
      // destination's list. The key is cleared (its prefix belonged to the old
      // project) and sprint/milestone/stage are reset to the destination's
      // defaults. One all-or-nothing batch, so a failure can't leave the parent
      // and its subtasks split across projects.
      await atomically(db, (handle) =>
        allIds.map((taskId, i) =>
          handle
            .update(t)
            .set({
              projectId: destProjectId,
              ...(taskId === id && { parentTaskId: null }),
              sprintId: null,
              milestoneId: null,
              stageId: resetStageId,
              status: resetStatus,
              key: null,
              position: basePosition + i,
              boardPosition: null,
              updatedAt: now,
            })
            .where(eq(t.id, taskId)),
        ),
      );

      // One event per moved task, so audit, analytics and subscriptions see every row that changed.
      const moved = [{ id, title: (existing as any).title as string }, ...descendants];
      for (const row of moved) {
        publishEntityEvent({
          c,
          entityType: 'project_task',
          entityId: row.id,
          action: 'updated',
          data: {
            id: row.id,
            title: row.title,
            projectId: destProjectId,
            status: resetStatus,
          },
        });
      }

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

/**
 * Writes a PATCH: the columns, plus the dependency rows when the body carried links,
 * as one unit. The completion is claimed before the (possibly batched) write, so two
 * concurrent completions cannot both spawn the next occurrence. Returns whether this
 * write completed the task.
 */
async function writePatchedTask(
  db: TaskDb,
  args: {
    id: string;
    existing: { status?: unknown };
    update: Record<string, any>;
    resolvedStatus: unknown;
    dependencyPlan: DependencyPlan | null;
  },
): Promise<boolean> {
  const { id, existing, update, resolvedStatus, dependencyPlan } = args;
  const completed = await claimCompletion(db, id, existing.status, resolvedStatus);
  if (dependencyPlan) {
    await commitDependencyUpdate(db, id, dependencyPlan, update);
  } else {
    await db.update(t).set(update).where(liveTask(id));
  }
  return completed;
}

/** The plan for the dependency lists a PATCH sends (null when it sends none), or the failure response. */
async function planPatchDependencies(
  c: TaskCtx,
  db: TaskDb,
  id: string,
  input: { dependsOn?: string[]; blocks?: string[] },
): Promise<DependencyPlan | null | Response> {
  if (input.dependsOn === undefined && input.blocks === undefined) return null;
  const plan = await planDependencyUpdate(c, db, id, input);
  return plan.ok ? plan : dependencyFailureResponse(c, id, plan);
}

/** The dependency lists a PATCH echoes back: only the ones the body sent. */
function dependencyEchoFor(
  plan: DependencyPlan | null,
  sent: { dependsOn?: unknown; blocks?: unknown },
): { dependsOn?: string[]; blocks?: string[] } {
  if (!plan) return {};
  return {
    ...(sent.dependsOn !== undefined && { dependsOn: plan.dependsOn }),
    ...(sent.blocks !== undefined && { blocks: plan.blocks }),
  };
}

/** Assignment notifications for the assignees a PATCH newly added. */
function notifyAddedAssigneesOnUpdate(
  c: TaskCtx,
  args: {
    id: string;
    existing: any;
    update: Record<string, any>;
    data: Record<string, any>;
  },
): void {
  const { id, existing, update, data } = args;
  const addedAssignees = newlyAddedAssignees(existing, update);
  if (addedAssignees.length === 0) return;
  dispatchAssignmentNotifications(c, {
    assigneeIds: addedAssignees,
    taskId: id,
    taskTitle: (data.title as string) || existing.title,
    projectId: existing.projectId ?? null,
    taskPriority: (data.priority as string | null) ?? existing.priority ?? null,
    dueDate: resolveUpdatedDate(data.dueDate, existing.dueDate),
    taskDescription:
      data.description !== undefined ? (data.description as string | null) : existing.description,
  });
}

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
    const id = c.req.param('id');
    const denied = await guardTaskWrite(c, id);
    if (denied) return denied;
    const body = c.req.valid('json') as Record<string, any>;
    // projectId / dependsOn / blocks are not plain column writes, see below.
    const { projectId: _projectId, dependsOn, blocks, ...data } = body;

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Task', id);

      const relationError = await validateTaskRelations(db, existing, id, body);
      if (relationError) return error.badRequest(c, relationError);

      // Dependencies run through the same checks + reciprocal sync as
      // PUT /:id/dependencies. Validated here, written below with the columns.
      const dependencyPlan = await planPatchDependencies(c, db, id, { dependsOn, blocks });
      if (dependencyPlan instanceof Response) return dependencyPlan;
      const dependencyEcho = dependencyEchoFor(dependencyPlan, { dependsOn, blocks });

      const update = buildTaskUpdate(data);
      const resolvedStatus = await applyStatusChange(db, existing, data, update);

      const completed = await writePatchedTask(db, { id, existing, update, resolvedStatus, dependencyPlan });

      // Phase 1 dual-write: mirror the customFields blob into the typed values table.
      await syncValuesForEntity(db, 'task', id, data.customFields);

      syncCalendarAfterUpdate(c, db, { existing, data, resolvedStatus, userId, id });

      const nextTaskId = await handleTaskCompletion(c, db, completed, {
        ...existing,
        ...update,
        status: resolvedStatus,
      });

      notifyAddedAssigneesOnUpdate(c, { id, existing, update, data });

      const changes = buildTaskChanges(
        existing as Record<string, unknown>,
        update,
        await fetchAssigneeNames(db, assigneeIdsInvolved(existing as Record<string, unknown>, update)),
      );
      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: id,
        action: 'updated',
        data: taskAnalyticsPayload(
          { ...(existing as Record<string, unknown>), ...data, ...dependencyEcho } as Record<string, unknown>,
          { id, title: (data.title as string) || (existing as any).title },
        ),
        changes,
      });

      dispatchGithubOutboundSync(c, {
        taskId: id,
        projectId: (existing as any).projectId,
        kinds: githubKindsForUpdate(data, resolvedStatus, (existing as any).status),
      });

      return success(c, { id, ...data, ...dependencyEcho, ...(nextTaskId && { nextTaskId }) });
    } catch (err) {
      console.error('[app-api/tasks] update failed:', err);
      return error.internal(c, 'Failed to update task');
    }
  },
);

// ============================================================================
// DELETE /:id — Soft delete the task and its subtask tree, with calendar event
// cleanup + dependency pruning (softDeleteTaskTree)
// ============================================================================

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const _taskAccess = await canWriteTaskProject(c, id);
  if (_taskAccess === 'not-found') return error.notFound(c, 'Task', id);
  if (_taskAccess === 'denied') return error.forbidden(c, TASK_PROJECT_WRITE_DENIED);
  try {
    const removed = await softDeleteTaskTree(db, id);
    if (!removed) return error.notFound(c, 'Task', id);

    for (const row of removed) {
      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: row.id,
        action: 'deleted',
        data: { id: row.id, title: row.title },
      });

      dispatchGithubOutboundSync(c, {
        taskId: row.id,
        projectId: row.projectId,
        kinds: ['delete'],
      });
    }

    return noContent(c);
  } catch (err) {
    console.error('[app-api/tasks] delete failed:', err);
    return error.internal(c, 'Failed to delete task');
  }
});

export const tasksRoutes = app;

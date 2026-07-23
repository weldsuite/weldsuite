/**
 * My Tasks route — read-only /api/my-tasks/* surface backed by `tasks`.
 * Ported from the legacy api-worker `/projects/my-tasks` handler so the
 * WeldFlow "My Tasks" page can move off the obsolete worker.
 *
 * Returns tasks assigned to the current authenticated user — either as the
 * primary `assigneeId` OR as one of the multi-assignees (`assigneeIds`) —
 * across all projects, each enriched with assignee display fields and a
 * lightweight project summary.
 *
 * Filters: search, status, priority, projectId, labelIds (CSV), dueDateBucket.
 * Sort: sortField + sortDirection (defaults to the legacy status-priority
 * ordering). Offset (page/pageSize) pagination — cursor pagination doesn't
 * fit arbitrary sort fields, so this surface stays page-based like the
 * legacy endpoint the WeldFlow infinite-scroll list expects.
 *
 * Read-only; no entity events. Permission: `tasks:read`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list } from '../../lib/response';
import { schema } from '../../db';
import {
  dueDateBucketEnum,
  taskSortFieldEnum,
  taskCsvStringArray,
  dueDateBucketCondition,
  resolveTaskSortColumn,
  enrichTasksWithAssignees,
} from '../tasks';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const myTasksFiltersSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  status: z.string().optional(),
  priority: z.string().optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
  labelIds: taskCsvStringArray,
  dueDateBucket: dueDateBucketEnum,
  sortField: taskSortFieldEnum,
  sortDirection: z.enum(['asc', 'desc']).optional().default('asc'),
});

app.get('/', requirePermission('tasks:read'), zValidator('query', myTasksFiltersSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');
  const { tasks, projects } = schema;

  // Tasks assigned to the user as primary assignee OR via the multi-assignee array.
  const conditions: any[] = [
    isNull(tasks.deletedAt),
    or(
      eq(tasks.assigneeId, userId),
      sql`${tasks.assigneeIds}::jsonb @> ${JSON.stringify([userId])}::jsonb`,
    )!,
  ];

  if (q.status) conditions.push(eq(tasks.status, q.status));
  if (q.priority) conditions.push(eq(tasks.priority, q.priority));
  if (q.projectId) conditions.push(eq(tasks.projectId, q.projectId));
  if (q.labelIds && q.labelIds.length > 0) {
    conditions.push(
      sql`${tasks.labels} ?| array[${sql.join(
        q.labelIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]`,
    );
  }
  if (q.dueDateBucket) {
    conditions.push(dueDateBucketCondition(q.dueDateBucket, tasks.dueDate));
  }
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(tasks.title, term), like(tasks.description, term), like(tasks.key, term))!);
  }

  try {
    const where = and(...conditions);
    const offset = (q.page - 1) * q.pageSize;

    // Sort: when no explicit field is requested (the default 'position') fall
    // back to the legacy status-priority CASE ordering so existing UX is kept.
    const sortDir = q.sortDirection === 'desc' ? desc : asc;
    const useDefaultSort = q.sortField === 'position';
    const primaryOrder = useDefaultSort
      ? asc(sql`CASE ${tasks.status}
          WHEN 'todo' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'in_review' THEN 3
          WHEN 'testing' THEN 4
          WHEN 'backlog' THEN 5
          WHEN 'done' THEN 6
          WHEN 'cancelled' THEN 7
          ELSE 8
        END`)
      : sortDir(resolveTaskSortColumn(q.sortField, tasks));

    const [rows, countResult] = await Promise.all([
      db
        .select({
          task: tasks,
          project: {
            id: projects.id,
            name: projects.name,
            color: projects.color,
            icon: projects.icon,
            status: projects.status,
          },
        })
        .from(tasks)
        .leftJoin(projects, eq(tasks.projectId, projects.id))
        .where(where)
        .orderBy(primaryOrder, desc(tasks.updatedAt), desc(tasks.id))
        .limit(q.pageSize)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(where),
    ]);

    const totalCount = Number(countResult[0]?.count ?? 0);
    const hasMore = offset + rows.length < totalCount;

    // Enrich with assignee display fields, then re-attach the project summary.
    const enriched = await enrichTasksWithAssignees(
      db,
      rows.map((r) => r.task),
    );
    const projectByTaskId = new Map(rows.map((r) => [r.task.id, r.project]));
    const data = enriched.map((task: any) => {
      const project = projectByTaskId.get(task.id);
      return { ...task, project: project?.id ? project : null };
    });

    // Offset-based: cursor is always null, hasMore drives the next page fetch.
    return list(c, data, cursorPagination(totalCount, hasMore, null));
  } catch (err) {
    console.error('[app-api/my-tasks] list failed:', err);
    return error.internal(c, 'Failed to list my tasks');
  }
});

export const myTasksRoutes = app;

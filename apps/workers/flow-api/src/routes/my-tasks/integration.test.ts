/**
 * DB-backed integration tests for GET /api/my-tasks. The route filters and
 * pages in SQL, so pglite is the only way to exercise the real query.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { myTasksRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// The harness authenticates as this user unless the context overrides it.
const ME = 'user_test_default';
const OTHER = 'user_someone_else';

let db: Database;

type ListBody = {
  data: Array<{ id: string; status: string }>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
};

async function getMyTasks(query = ''): Promise<{ status: number; body: ListBody }> {
  const { request } = createTestApp('/api/my-tasks', myTasksRoutes, {
    context: { permissions: permissions('tasks:read'), tenantDb: db },
  });
  const res = await request(`/api/my-tasks${query ? `?${query}` : ''}`);
  return { status: res.status, body: (await res.json()) as ListBody };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const base = Date.UTC(2026, 0, 1);
  const row = (
    id: string,
    status: string,
    extra: Partial<typeof schema.tasks.$inferInsert> = {},
  ) =>
    ({
      id,
      title: `Task ${id}`,
      status,
      assigneeId: ME,
      createdAt: new Date(base),
      updatedAt: new Date(base),
      ...extra,
    }) as typeof schema.tasks.$inferInsert;

  await db.insert(schema.tasks).values([
    // Mine, open (4): two todo, one in_progress, one reached via assigneeIds only.
    row('task_mt_todo_a', 'todo'),
    row('task_mt_todo_b', 'todo'),
    row('task_mt_progress', 'in_progress'),
    row('task_mt_multi', 'backlog', { assigneeId: OTHER, assigneeIds: [ME, OTHER] }),
    // Mine, closed (2).
    row('task_mt_done', 'done'),
    row('task_mt_cancelled', 'cancelled'),
    // Someone else's: must never show up for ME.
    row('task_mt_other_open', 'todo', { assigneeId: OTHER }),
    row('task_mt_other_done', 'done', { assigneeId: OTHER }),
  ]);
}, 60_000);

describe('/api/my-tasks · excludeStatus · pglite integration', () => {
  it('excludeStatus=done,cancelled omits those rows and totalCount reflects the filtered count', async () => {
    const { status, body } = await getMyTasks('excludeStatus=done,cancelled');
    expect(status).toBe(200);
    const ids = body.data.map((t) => t.id).sort();
    expect(ids).toEqual(['task_mt_multi', 'task_mt_progress', 'task_mt_todo_a', 'task_mt_todo_b']);
    expect(body.data.every((t) => t.status !== 'done' && t.status !== 'cancelled')).toBe(true);
    expect(body.pagination.totalCount).toBe(4);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('still returns done and cancelled rows when excludeStatus is absent', async () => {
    const { status, body } = await getMyTasks();
    expect(status).toBe(200);
    const ids = body.data.map((t) => t.id);
    expect(ids).toContain('task_mt_done');
    expect(ids).toContain('task_mt_cancelled');
    expect(body.pagination.totalCount).toBe(6);
  });

  it('treats an empty excludeStatus as no filter', async () => {
    const { status, body } = await getMyTasks('excludeStatus=');
    expect(status).toBe(200);
    expect(body.pagination.totalCount).toBe(6);
  });

  it('does not return tasks assigned to another user', async () => {
    const { body } = await getMyTasks('excludeStatus=cancelled');
    const ids = body.data.map((t) => t.id);
    expect(ids).not.toContain('task_mt_other_open');
    expect(ids).not.toContain('task_mt_other_done');
    // Reached via the multi-assignee array while someone else is primary.
    expect(ids).toContain('task_mt_multi');
    expect(body.pagination.totalCount).toBe(5);
  });
});

describe('/api/my-tasks · pagination · pglite integration', () => {
  it('pages through the filtered set without duplicates and flips hasMore on the last page', async () => {
    const first = await getMyTasks('excludeStatus=done,cancelled&page=1&pageSize=2');
    const second = await getMyTasks('excludeStatus=done,cancelled&page=2&pageSize=2');

    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination.hasMore).toBe(true);
    expect(first.body.pagination.totalCount).toBe(4);

    expect(second.body.data).toHaveLength(2);
    expect(second.body.pagination.hasMore).toBe(false);
    expect(second.body.pagination.totalCount).toBe(4);

    const ids = [...first.body.data, ...second.body.data].map((t) => t.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('pages through the unfiltered set exactly once per row', async () => {
    const ids: string[] = [];
    let hasMore = true;
    for (let page = 1; hasMore && page <= 10; page++) {
      const { body } = await getMyTasks(`page=${page}&pageSize=2`);
      ids.push(...body.data.map((t) => t.id));
      hasMore = body.pagination.hasMore;
    }
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

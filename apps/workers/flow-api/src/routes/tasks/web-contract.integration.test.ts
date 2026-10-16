/**
 * Contract the web client relies on (TASK-794 clearing, TASK-795 paging) and the
 * rule that a soft-deleted project's tasks drop out of the lists.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasksRoutes } from './index';
import { myTasksRoutes } from '../my-tasks';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const now = new Date();
const json = { 'Content-Type': 'application/json' };
const ME = 'user_test_default';

const seedProject = (id: string, extra: Record<string, unknown> = {}) =>
  db
    .insert(schema.projects)
    .values({ id, name: id, createdAt: now, updatedAt: now, ...extra } as typeof schema.projects.$inferInsert);
const seedTask = (values: Record<string, unknown>) =>
  db.insert(schema.tasks).values({ title: 'Task', ...values } as typeof schema.tasks.$inferInsert);
const row = async (id: string) => {
  const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return found;
};
const send = (method: string, path: string, body?: unknown) =>
  createTestApp('/api/tasks', tasksRoutes, {
    context: {
      permissions: permissions('tasks:read', 'tasks:create', 'tasks:update', 'projects:scope:all'),
      tenantDb: db,
    },
  }).request(`/api/tasks${path}`, {
    method,
    headers: json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const idsOf = async (res: Response) => ((await res.json()) as { data: { id: string }[] }).data.map((task) => task.id);

describe('soft-deleted projects', () => {
  it('hides their tasks from the task list and My Tasks, but keeps personal tasks', async () => {
    await seedProject('proj_dead', { deletedAt: now });
    await seedTask({ id: 'task_dead_proj', projectId: 'proj_dead', assigneeId: ME });
    await seedTask({ id: 'task_dead_personal', projectId: null, assigneeId: ME });

    const listed = await idsOf(await send('GET', '?limit=200'));
    expect(listed).toContain('task_dead_personal');
    expect(listed).not.toContain('task_dead_proj');

    const { request } = createTestApp('/api/my-tasks', myTasksRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });
    const mine = await idsOf(await request('/api/my-tasks?pageSize=100'));
    expect(mine).toContain('task_dead_personal');
    expect(mine).not.toContain('task_dead_proj');
  });
});

describe('web contract: clearing and paging', () => {
  it('assigneeIds: [], repeat: null, labels: [] and duration: null clear their fields', async () => {
    await seedTask({
      id: 'task_web_clear',
      assigneeId: ME,
      assigneeIds: [ME],
      repeat: { frequency: 'weekly' },
      labels: ['l1'],
      duration: 30,
    });
    const res = await send('PATCH', '/task_web_clear', { assigneeIds: [], repeat: null, labels: [], duration: null });
    expect(res.status).toBe(200);
    const cleared = await row('task_web_clear');
    expect(cleared?.assigneeId).toBeNull();
    expect(cleared?.assigneeIds).toBeNull();
    expect(cleared?.repeat).toBeNull();
    expect(cleared?.labels).toEqual([]);
    expect(cleared?.duration).toBeNull();
  });

  it('a project list accepts pageSize up to 200 and keeps equal positions in a stable order', async () => {
    await seedProject('proj_page200');
    for (let i = 0; i < 5; i++) await seedTask({ id: `task_p200_${i}`, projectId: 'proj_page200', position: 1 });
    const res = await send('GET', '?projectId=proj_page200&page=1&pageSize=200');
    expect(res.status).toBe(200);
    const first = await idsOf(res);
    const again = await idsOf(await send('GET', '?projectId=proj_page200&pageSize=200'));
    expect(first).toHaveLength(5);
    expect(again).toEqual(first);
    expect((await send('GET', '?projectId=proj_page200&pageSize=201')).status).toBe(400);
  });
});

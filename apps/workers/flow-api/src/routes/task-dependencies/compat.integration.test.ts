/**
 * The transition release of FLOW-015: `tasks.depends_on` / `tasks.blocks` stay
 * and are kept in step with the typed `task_dependencies` rows, in both
 * directions. This file is the arrays-to-rows direction, through the tasks
 * routes (the rows-to-arrays direction is in ./integration.test.ts): a write
 * through `dependsOn` / `blocks` upserts `fs` / lag 0 rows and removes dropped
 * pairs, without touching the type or lag of a pair that has a row. Runs
 * against the TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq, or } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { tasksRoutes } from '../tasks';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const USER = 'user_compat';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const json = { 'Content-Type': 'application/json' };

function send(method: string, path: string, body?: unknown) {
  const { request } = createTestApp('/api/tasks', tasksRoutes, {
    context: { userId: USER, permissions: permissions('tasks:read', 'tasks:update', 'tasks:delete', 'projects:scope:all'), tenantDb: db },
  });
  return request(`/api/tasks${path}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function seedProject(id: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, createdAt: now, updatedAt: now });
}

async function seedTask(id: string, projectId: string | null, extra: Record<string, unknown> = {}) {
  await db.insert(schema.tasks).values({ id, title: `Task ${id}`, projectId, ...extra } as typeof schema.tasks.$inferInsert);
}

const rowsOf = (...ids: string[]) =>
  db
    .select()
    .from(schema.taskDependencies)
    .where(or(...ids.flatMap((id) => [eq(schema.taskDependencies.predecessorId, id), eq(schema.taskDependencies.successorId, id)])));

const pairs = async (...ids: string[]) =>
  (await rowsOf(...ids))
    .map((row) => `${row.predecessorId}>${row.successorId}:${row.type}:${row.lagDays}`)
    .sort();

describe('writes through dependsOn and blocks keep the typed rows in step', () => {
  it('PUT /:id/dependencies upserts fs rows with no lag and removes the pairs it drops', async () => {
    await seedProject('prj_cp_put');
    for (const name of ['a', 'b', 'c']) await seedTask(`task_cp_put_${name}`, 'prj_cp_put');

    const added = await send('PUT', '/task_cp_put_b/dependencies', { dependsOn: ['task_cp_put_a'], blocks: ['task_cp_put_c'] });
    expect(added.status).toBe(200);
    expect(await pairs('task_cp_put_b')).toEqual(['task_cp_put_a>task_cp_put_b:fs:0', 'task_cp_put_b>task_cp_put_c:fs:0']);
    const [row] = await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.successorId, 'task_cp_put_b'));
    expect(row).toMatchObject({ projectId: 'prj_cp_put', createdBy: USER });
    expect(row.id).toMatch(/^tdp_/);

    const dropped = await send('PUT', '/task_cp_put_b/dependencies', { dependsOn: [], blocks: ['task_cp_put_c'] });
    expect(dropped.status).toBe(200);
    expect(await pairs('task_cp_put_b')).toEqual(['task_cp_put_b>task_cp_put_c:fs:0']);
  });

  it('PATCH /:id with the lists writes the rows with the columns', async () => {
    await seedProject('prj_cp_patch');
    for (const name of ['a', 'b']) await seedTask(`task_cp_patch_${name}`, 'prj_cp_patch');

    const res = await send('PATCH', '/task_cp_patch_b', { title: 'Renamed', dependsOn: ['task_cp_patch_a'] });
    expect(res.status).toBe(200);
    expect(await pairs('task_cp_patch_b')).toEqual(['task_cp_patch_a>task_cp_patch_b:fs:0']);

    await send('PATCH', '/task_cp_patch_b', { dependsOn: [] });
    expect(await pairs('task_cp_patch_b')).toEqual([]);
  });

  it('leaves the type and the lag of a pair that already has a row alone', async () => {
    await seedProject('prj_cp_keep');
    for (const name of ['a', 'b', 'c']) await seedTask(`task_cp_keep_${name}`, 'prj_cp_keep');
    await db.insert(schema.taskDependencies).values({
      id: 'tdp_cp_keep',
      projectId: 'prj_cp_keep',
      predecessorId: 'task_cp_keep_a',
      successorId: 'task_cp_keep_b',
      type: 'ss',
      lagDays: 3,
      createdBy: 'user_someone',
    });

    // The arrays do not know the pair yet (a row written through /api/task-dependencies has them in step; this is the old state).
    const res = await send('PUT', '/task_cp_keep_b/dependencies', { dependsOn: ['task_cp_keep_a', 'task_cp_keep_c'] });
    expect(res.status).toBe(200);
    expect(await pairs('task_cp_keep_b')).toEqual(['task_cp_keep_a>task_cp_keep_b:ss:3', 'task_cp_keep_c>task_cp_keep_b:fs:0']);
    const [kept] = await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.id, 'tdp_cp_keep'));
    expect(kept.createdBy).toBe('user_someone');
  });

  it('keeps a link to a task of another project, or to a personal task, in the arrays only', async () => {
    await seedProject('prj_cp_one');
    await seedProject('prj_cp_two');
    await seedTask('task_cp_x_mine', 'prj_cp_one');
    await seedTask('task_cp_x_other', 'prj_cp_two');
    await seedTask('task_cp_x_personal', null);

    const res = await send('PUT', '/task_cp_x_mine/dependencies', { dependsOn: ['task_cp_x_other'], blocks: ['task_cp_x_personal'] });
    expect(res.status).toBe(200);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task_cp_x_mine')))[0]?.dependsOn).toEqual(['task_cp_x_other']);
    expect(await pairs('task_cp_x_mine')).toEqual([]);
  });

  it('finds a cycle that only the table knows about', async () => {
    await seedProject('prj_cp_cycle');
    await seedTask('task_cp_cy_a', 'prj_cp_cycle');
    await seedTask('task_cp_cy_b', 'prj_cp_cycle');
    // B waits for A, as a row (the arrays of both are empty).
    await db.insert(schema.taskDependencies).values({
      id: 'tdp_cp_cycle',
      projectId: 'prj_cp_cycle',
      predecessorId: 'task_cp_cy_a',
      successorId: 'task_cp_cy_b',
      createdBy: USER,
    });

    const res = await send('PUT', '/task_cp_cy_a/dependencies', { dependsOn: ['task_cp_cy_b'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Circular dependency detected');
    const viaBlocks = await send('PUT', '/task_cp_cy_b/dependencies', { blocks: ['task_cp_cy_a'] });
    expect(viaBlocks.status).toBe(400);
  });
});

describe('deleting a task deletes its typed rows', () => {
  it('takes the rows of the task and of its subtasks with it, and leaves the others', async () => {
    await seedProject('prj_cp_del');
    await seedTask('task_cp_del_parent', 'prj_cp_del');
    await seedTask('task_cp_del_child', 'prj_cp_del', { parentTaskId: 'task_cp_del_parent' });
    await seedTask('task_cp_del_a', 'prj_cp_del');
    await seedTask('task_cp_del_b', 'prj_cp_del');
    const base = { projectId: 'prj_cp_del', createdBy: USER };
    await db.insert(schema.taskDependencies).values([
      { id: 'tdp_cp_del_1', predecessorId: 'task_cp_del_a', successorId: 'task_cp_del_parent', ...base },
      { id: 'tdp_cp_del_2', predecessorId: 'task_cp_del_child', successorId: 'task_cp_del_b', ...base },
      { id: 'tdp_cp_del_3', predecessorId: 'task_cp_del_a', successorId: 'task_cp_del_b', ...base },
    ]);

    const res = await send('DELETE', '/task_cp_del_parent');
    expect(res.status).toBe(204);
    const left = await db.select({ id: schema.taskDependencies.id }).from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, 'prj_cp_del'));
    expect(left.map((row) => row.id)).toEqual(['tdp_cp_del_3']);
  });
});

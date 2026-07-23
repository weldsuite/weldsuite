/**
 * DB-backed integration tests for /api/tasks. Tasks writes directly via
 * Drizzle (no service) so pglite is the only way to exercise the full
 * SQL path.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasksRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import type { Variables } from '../../types';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/tasks · pglite integration', () => {
  it('POST / writes a task and publishes task.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:create'), tenantDb: db },
    });

    const res = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ship the test suite' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; title: string } };
    expect(body.data.id).toMatch(/^task_/);
    expect(body.data.title).toBe('Ship the test suite');

    const [row] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, body.data.id))
      .limit(1);
    expect(row?.title).toBe('Ship the test suite');

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.entityType).toBe('project_task');
    expect(call.action).toBe('created');
  });

  it('GET /:id returns 404 for a missing task', async () => {
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });
    const res = await request('/api/tasks/task_missing');
    expect(res.status).toBe(404);
  });
});

describe('/api/tasks/:id/move · pglite integration', () => {
  // Stub flag evaluators mirroring what featureFlagsMiddleware resolves from
  // Flagship. `flagsOn` = the user is inside the rollout; `flagsOff` = not.
  const flagsOn = {
    isOn: async () => true,
    getValue: async () => true,
  } as unknown as NonNullable<Variables['flags']>;
  const flagsOff = {
    isOn: async () => false,
    getValue: async () => false,
  } as unknown as NonNullable<Variables['flags']>;

  const now = new Date();
  const seedProject = (id: string, name: string) =>
    db
      .insert(schema.projects)
      .values({ id, name, createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert);

  it('moves a task + its subtasks and resets project-scoped fields', async () => {
    await seedProject('proj_src_move', 'Source');
    await seedProject('proj_dst_move', 'Destination');
    // Two stages — the move must pick the lowest-position one as the default.
    await db.insert(schema.projectPipelineStages).values([
      { id: 'stage_dst_todo', projectId: 'proj_dst_move', name: 'To Do', position: 0, systemStatus: 'in_progress' },
      { id: 'stage_dst_done', projectId: 'proj_dst_move', name: 'Done', position: 5, systemStatus: 'done' },
    ] as (typeof schema.projectPipelineStages.$inferInsert)[]);
    await db.insert(schema.tasks).values([
      {
        id: 'task_mv_parent',
        title: 'Parent',
        projectId: 'proj_src_move',
        sprintId: 'sprint_old',
        milestoneId: 'ms_old',
        stageId: 'stage_old',
        key: 'SRC-1',
        status: 'todo',
        boardPosition: 7,
      },
      { id: 'task_mv_child', title: 'Child', projectId: 'proj_src_move', parentTaskId: 'task_mv_parent', stageId: 'stage_old' },
    ] as (typeof schema.tasks.$inferInsert)[]);

    mockedPublish.mockClear();
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db, flags: flagsOn },
    });

    const res = await request('/api/tasks/task_mv_parent/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj_dst_move' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; projectId: string; movedSubtaskCount: number };
    };
    expect(body.data.projectId).toBe('proj_dst_move');
    expect(body.data.movedSubtaskCount).toBe(1);

    const [parent] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task_mv_parent')).limit(1);
    expect(parent?.projectId).toBe('proj_dst_move');
    expect(parent?.sprintId).toBeNull();
    expect(parent?.milestoneId).toBeNull();
    expect(parent?.key).toBeNull();
    expect(parent?.boardPosition).toBeNull();
    // Reset to the destination's lowest-position stage + its systemStatus.
    expect(parent?.stageId).toBe('stage_dst_todo');
    expect(parent?.status).toBe('in_progress');

    const [child] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task_mv_child')).limit(1);
    expect(child?.projectId).toBe('proj_dst_move');
    expect(child?.sprintId).toBeNull();
    // Hierarchy is preserved — the subtask still points at its parent.
    expect(child?.parentTaskId).toBe('task_mv_parent');

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as { entityType: string; action: string };
    expect(call.entityType).toBe('project_task');
    expect(call.action).toBe('updated');
  });

  it('is forbidden (403) when the weldflow-move-task flag is off', async () => {
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db, flags: flagsOff },
    });
    const res = await request('/api/tasks/task_mv_parent/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj_dst_move' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the destination project does not exist', async () => {
    await seedProject('proj_src_404', 'Src404');
    await db
      .insert(schema.tasks)
      .values({ id: 'task_404', title: 'T', projectId: 'proj_src_404' } as typeof schema.tasks.$inferInsert);

    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db, flags: flagsOn },
    });
    const res = await request('/api/tasks/task_404/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('is a no-op (movedSubtaskCount 0) when already in the destination project', async () => {
    await seedProject('proj_same', 'Same');
    await db
      .insert(schema.tasks)
      .values({ id: 'task_same', title: 'T', projectId: 'proj_same' } as typeof schema.tasks.$inferInsert);

    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db, flags: flagsOn },
    });
    const res = await request('/api/tasks/task_same/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj_same' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { movedSubtaskCount: number } };
    expect(body.data.movedSubtaskCount).toBe(0);
  });

  it('rejects an empty projectId with 400', async () => {
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:update'), tenantDb: db, flags: flagsOn },
    });
    const res = await request('/api/tasks/task_same/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('/api/tasks · numbering · pglite integration', () => {
  async function createTask(title: string): Promise<{ id: string; number: number }> {
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:create'), tenantDb: db },
    });
    const res = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; number: number } };
    return body.data;
  }

  it('assigns a positive integer number on create and returns it', async () => {
    const created = await createTask('Numbered task A');
    expect(typeof created.number).toBe('number');
    expect(created.number).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, created.id))
      .limit(1);
    expect(row?.number).toBe(created.number);
  });

  it('allocates strictly increasing, unique numbers for consecutive creates', async () => {
    const first = await createTask('Numbered task B');
    const second = await createTask('Numbered task C');
    expect(second.number).toBe(first.number + 1);
    expect(second.number).not.toBe(first.number);
  });

  it('finds a task by its number via search (bare, #, and TASK- forms)', async () => {
    const created = await createTask('Findable by number');
    const { request } = createTestApp('/api/tasks', tasksRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });

    for (const q of [`${created.number}`, `#${created.number}`, `TASK-${created.number}`]) {
      const res = await request(`/api/tasks?search=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.some((t) => t.id === created.id)).toBe(true);
    }
  });
});

/**
 * DB-backed integration tests for the goals canvas (TASK-785).
 *
 * `project_goals` has no unique key on the project, so GET, PUT and POST must
 * all agree on one canonical row and a first save must not create a second one.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { goalsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let db: Database;
let request: ReturnType<typeof createTestApp>['request'];

const send = (method: string, path: string, body?: unknown) =>
  request(`/api/goals${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function seedProject(id: string) {
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({ id, name: id, createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert)
    .onConflictDoNothing();
}

async function rowsOf(projectId: string) {
  return db
    .select()
    .from(schema.projectGoals)
    .where(and(eq(schema.projectGoals.projectId, projectId), isNull(schema.projectGoals.deletedAt)));
}

const card = (id: string) => ({ id, title: `Goal ${id}` });

async function canvasOf(projectId: string) {
  const res = await send('GET', `/by-project/${projectId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { mission: unknown; goals: Array<{ id: string; title: string }> } }).data;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  request = createTestApp('/api/goals', goalsRoutes, {
    context: {
      userId: 'user_goals',
      permissions: permissions('projects:read', 'projects:create', 'projects:update', 'projects:delete', 'projects:scope:all'),
      tenantDb: db,
    },
  }).request;
}, 60_000);

describe('by-project canvas', () => {
  it('saves and reads back through the same row, however often it is saved', async () => {
    await seedProject('prj_g_basic');

    expect((await send('PUT', '/by-project/prj_g_basic', { mission: { id: 'm' }, goals: [card('a')] })).status).toBe(201);
    expect((await send('PUT', '/by-project/prj_g_basic', { mission: { id: 'm' }, goals: [card('a'), card('b')] })).status).toBe(200);

    expect(await rowsOf('prj_g_basic')).toHaveLength(1);
    expect((await canvasOf('prj_g_basic')).goals.map((g) => g.id)).toEqual(['a', 'b']);
  });

  it('two simultaneous first saves still leave one row', async () => {
    await seedProject('prj_g_race');
    const save = (id: string) => send('PUT', '/by-project/prj_g_race', { mission: { id: 'm' }, goals: [card(id)] });

    const results = await Promise.all([save('x'), save('y')]);

    expect(results.every((r) => r.status < 300)).toBe(true);
    expect(await rowsOf('prj_g_race')).toHaveLength(1);
  });

  it('reads and writes the row that holds the data when older duplicates exist', async () => {
    await seedProject('prj_g_dupes');
    const now = new Date();
    const old = new Date(now.getTime() - 60_000);
    // The row autosave wrote to, and a newer empty one created by POST /goals.
    await db.insert(schema.projectGoals).values({
      id: 'goal_dupe_data', projectId: 'prj_g_dupes', mission: { id: 'm' }, goals: [card('keep')], createdAt: old, updatedAt: old,
    });
    await db.insert(schema.projectGoals).values({
      id: 'goal_dupe_empty', projectId: 'prj_g_dupes', mission: null, goals: [], createdAt: now, updatedAt: now,
    });

    expect((await canvasOf('prj_g_dupes')).goals.map((g) => g.id)).toEqual(['keep']);

    await send('PUT', '/by-project/prj_g_dupes', { mission: { id: 'm' }, goals: [card('keep'), card('more')] });

    expect((await canvasOf('prj_g_dupes')).goals.map((g) => g.id)).toEqual(['keep', 'more']);
    const [empty] = await db.select().from(schema.projectGoals).where(eq(schema.projectGoals.id, 'goal_dupe_empty'));
    expect(empty?.goals).toEqual([]);
  });
});

describe('POST /', () => {
  it('requires a projectId (400, not a NOT NULL 500)', async () => {
    expect((await send('POST', '', { title: 'No project' })).status).toBe(400);
  });

  it('adds a goal card to the canvas instead of inserting a blank row', async () => {
    await seedProject('prj_g_post');
    await send('PUT', '/by-project/prj_g_post', { mission: { id: 'm' }, goals: [card('existing')] });

    const res = await send('POST', '', {
      projectId: 'prj_g_post',
      title: 'Ship it',
      status: 'at-risk',
      progress: 40,
      id: 'goal_hijack',
      deletedAt: '2020-01-01T00:00:00Z',
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; goalId: string } };
    expect(await rowsOf('prj_g_post')).toHaveLength(1);
    expect(data.id).not.toBe('goal_hijack');

    const canvas = await canvasOf('prj_g_post');
    expect(canvas.goals.map((g) => g.id)).toEqual(['existing', data.goalId]);
    expect(canvas.goals[1]).toMatchObject({ title: 'Ship it', status: 'at-risk', progress: 40 });
  });

  it('creates the canvas when the project has none yet', async () => {
    await seedProject('prj_g_post_new');
    expect((await send('POST', '', { projectId: 'prj_g_post_new', name: 'First' })).status).toBe(201);
    expect((await canvasOf('prj_g_post_new')).goals.map((g) => g.title)).toEqual(['First']);
  });
});

describe('PATCH /:id', () => {
  it('only changes the canvas columns, never the id or the project', async () => {
    await seedProject('prj_g_patch');
    await seedProject('prj_g_patch_other');
    const saved = await send('PUT', '/by-project/prj_g_patch', { mission: { id: 'm' }, goals: [card('a')] });
    const { data } = (await saved.json()) as { data: { id: string } };

    const res = await send('PATCH', `/${data.id}`, {
      goals: [card('a'), card('b')],
      id: 'goal_other',
      projectId: 'prj_g_patch_other',
      deletedAt: '2020-01-01T00:00:00Z',
    });

    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.projectGoals).where(eq(schema.projectGoals.id, data.id));
    expect(row?.projectId).toBe('prj_g_patch');
    expect(row?.deletedAt).toBeNull();
    expect(row?.goals as unknown[]).toHaveLength(2);
  });
});

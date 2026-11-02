/**
 * DB-backed integration tests for project pipeline stages (TASK-782, TASK-783).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { defaultStageId, projectPipelineStagesRoutes, slugifyStage } from './index';
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
  request(`/api/project-pipeline-stages${path}`, {
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

async function seedTask(id: string, projectId: string, stageId: string | null, status: string) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    title: id,
    projectId,
    stageId,
    status,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.tasks.$inferInsert);
}

async function taskRow(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return row;
}

type StageDto = { id: string; name: string; systemStatus: string; usageCount?: number };

async function stagesOf(projectId: string): Promise<StageDto[]> {
  const res = await send('GET', `?projectId=${projectId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: StageDto[] }).data;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  request = createTestApp('/api/project-pipeline-stages', projectPipelineStagesRoutes, {
    context: {
      userId: 'user_stages',
      permissions: permissions('projects:read', 'projects:create', 'projects:update', 'projects:delete', 'projects:scope:all'),
      tenantDb: db,
    },
  }).request;
}, 60_000);

describe('stage ids', () => {
  it('slugifyStage always fits varchar(30) and stays readable', () => {
    const id = slugifyStage('Waiting for customer feedback and legal review');
    expect(id.length).toBeLessThanOrEqual(30);
    expect(id).toMatch(/^waiting_for_customer_feed_[A-Za-z0-9]{4}$/i);
    expect(slugifyStage('!!!').length).toBeLessThanOrEqual(30);
    expect(slugifyStage('日本語')).toMatch(/^stage_/);
  });

  it('defaultStageId is stable per project and index, and fits the column', () => {
    expect(defaultStageId('proj_abc', 2)).toBe(defaultStageId('proj_abc', 2));
    expect(defaultStageId('proj_abc', 2)).not.toBe(defaultStageId('proj_abc', 3));
    expect(defaultStageId('proj_abc', 2).length).toBeLessThanOrEqual(30);
    expect(defaultStageId('p'.repeat(60), 1).length).toBeLessThanOrEqual(30);
  });

  it('creates a stage with a long name (201, not a 500 from the id column)', async () => {
    await seedProject('prj_st_long');

    const res = await send('POST', '', { projectId: 'prj_st_long', name: 'Waiting for customer feedback' });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: StageDto };
    expect(data.id.length).toBeLessThanOrEqual(30);
  });
});

describe('seeding defaults', () => {
  it('concurrent first loads seed one board of six columns, not two', async () => {
    await seedProject('prj_st_seed');

    const responses = await Promise.all([1, 2, 3].map(() => send('GET', '?projectId=prj_st_seed')));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const rows = await db
      .select()
      .from(schema.projectPipelineStages)
      .where(and(eq(schema.projectPipelineStages.projectId, 'prj_st_seed'), isNull(schema.projectPipelineStages.deletedAt)));
    expect(rows).toHaveLength(6);
    expect((await stagesOf('prj_st_seed')).map((s) => s.systemStatus)).toEqual([
      'backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled',
    ]);
  });
});

describe('DELETE /:id', () => {
  async function board(projectId: string) {
    await seedProject(projectId);
    const stages = await stagesOf(projectId);
    const by = (status: string) => stages.find((s) => s.systemStatus === status)!;
    return { by };
  }

  it('refuses a move target from another project', async () => {
    const mine = await board('prj_st_del_a');
    const theirs = await board('prj_st_del_b');
    await seedTask('task_st_foreign', 'prj_st_del_a', mine.by('review').id, 'review');

    const res = await send('DELETE', `/${mine.by('review').id}?moveTasksToStageId=${theirs.by('todo').id}`);

    expect(res.status).toBe(400);
    expect((await taskRow('task_st_foreign'))?.stageId).toBe(mine.by('review').id);
    expect((await stagesOf('prj_st_del_a')).some((s) => s.id === mine.by('review').id)).toBe(true);
  });

  it('moves tasks to the requested stage and re-labels them', async () => {
    const { by } = await board('prj_st_del_c');
    await seedTask('task_st_move', 'prj_st_del_c', by('review').id, 'review');

    const res = await send('DELETE', `/${by('review').id}?moveTasksToStageId=${by('done').id}`);

    expect(res.status).toBe(204);
    const task = await taskRow('task_st_move');
    expect(task?.stageId).toBe(by('done').id);
    expect(task?.status).toBe('done');
    expect(task?.completedDate).toBeTruthy();
  });

  it('falls back to the To Do column when no target is given', async () => {
    const { by } = await board('prj_st_del_d');
    await seedTask('task_st_fallback', 'prj_st_del_d', by('review').id, 'review');

    expect((await send('DELETE', `/${by('review').id}`)).status).toBe(204);

    const task = await taskRow('task_st_fallback');
    expect(task?.stageId).toBe(by('todo').id);
    expect(task?.status).toBe('todo');
  });
});

describe('PATCH /:id', () => {
  it('cascades a changed system status to the tasks already in the stage', async () => {
    await seedProject('prj_st_patch');
    const stages = await stagesOf('prj_st_patch');
    const review = stages.find((s) => s.systemStatus === 'review')!;
    await seedTask('task_st_cascade', 'prj_st_patch', review.id, 'review');
    await seedTask('task_st_elsewhere', 'prj_st_patch', stages[0]!.id, 'backlog');

    const res = await send('PATCH', `/${review.id}`, { systemStatus: 'testing' });

    expect(res.status).toBe(200);
    expect((await taskRow('task_st_cascade'))?.status).toBe('testing');
    expect((await taskRow('task_st_elsewhere'))?.status).toBe('backlog');
  });

  it('gives legacy tasks (no stageId, status = the stage id) the stage id, so they stay in it', async () => {
    await seedProject('prj_st_legacy');
    const created = await send('POST', '', { projectId: 'prj_st_legacy', name: 'Blocked', systemStatus: 'blocked' });
    const stage = ((await created.json()) as { data: StageDto }).data;
    await seedTask('task_st_legacy', 'prj_st_legacy', null, stage.id);

    const res = await send('PATCH', `/${stage.id}`, { systemStatus: 'in_progress' });

    expect(res.status).toBe(200);
    const task = await taskRow('task_st_legacy');
    expect(task?.status).toBe('in_progress');
    expect(task?.stageId).toBe(stage.id);
  });

  it('keeps the completion date of a task that was already done', async () => {
    await seedProject('prj_st_done');
    const stages = await stagesOf('prj_st_done');
    const review = stages.find((s) => s.systemStatus === 'review')!;
    const finishedOn = new Date('2026-01-15T09:00:00.000Z');
    await seedTask('task_st_was_done', 'prj_st_done', review.id, 'done');
    await db.update(schema.tasks).set({ completedDate: finishedOn }).where(eq(schema.tasks.id, 'task_st_was_done'));
    await seedTask('task_st_now_done', 'prj_st_done', review.id, 'review');

    const res = await send('PATCH', `/${review.id}`, { systemStatus: 'done' });

    expect(res.status).toBe(200);
    expect((await taskRow('task_st_was_done'))?.completedDate).toEqual(finishedOn);
    const nowDone = await taskRow('task_st_now_done');
    expect(nowDone?.status).toBe('done');
    expect(nowDone?.completedDate).toBeInstanceOf(Date);
    expect(nowDone?.completedDate?.getTime()).toBeGreaterThan(finishedOn.getTime());
  });

  it('leaves tasks alone when only the name changes', async () => {
    await seedProject('prj_st_rename');
    const stages = await stagesOf('prj_st_rename');
    const todo = stages.find((s) => s.systemStatus === 'todo')!;
    await seedTask('task_st_rename', 'prj_st_rename', todo.id, 'todo');
    const before = await taskRow('task_st_rename');

    await send('PATCH', `/${todo.id}`, { name: 'Up next' });

    expect((await taskRow('task_st_rename'))?.updatedAt).toEqual(before?.updatedAt);
  });
});

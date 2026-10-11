/**
 * Task status on /v1/tasks against a real (pglite) Postgres: a status change
 * moves the task's board stage the same way flow-api's PATCH /api/tasks/:id does
 * (both run applyStatusChange from @weldsuite/flow-domain/task-stage), the
 * legacy `in_review` is stored as `review`, and a `review` filter still finds
 * rows written before that. The mcp-server's copy of this route is identical.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.projectPipelineStages).values([
    { id: 'stg_xst_todo', projectId: 'proj_xst', name: 'To Do', position: 0, systemStatus: 'todo' },
    { id: 'stg_xst_doing', projectId: 'proj_xst', name: 'In Progress', position: 1, systemStatus: 'in_progress' },
    { id: 'stg_xst_review', projectId: 'proj_xst', name: 'In Review', position: 2, systemStatus: 'review' },
    { id: 'stg_xst_done', projectId: 'proj_xst', name: 'Done', position: 3, systemStatus: 'done' },
  ] as (typeof schema.projectPipelineStages.$inferInsert)[]);
}, 60_000);

describe('/v1/tasks status · board stage sync · pglite integration', () => {
  const seedTask = (values: Record<string, unknown>) =>
    db.insert(schema.tasks).values({ title: 'Task', projectId: 'proj_xst', ...values } as typeof schema.tasks.$inferInsert);
  const row = async (id: string) => {
    const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    return found;
  };
  const request = (path: string, init?: RequestInit, scopes = ['tasks:read', 'tasks:write']) => {
    const { app, env } = createExternalTestApp({ scopes, tenantDb: db });
    return app.request(path, init, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
  };
  const patch = (id: string, body: Record<string, unknown>) =>
    request(`/v1/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('moves the task to the stage of its new status', async () => {
    await seedTask({ id: 'task_xst_move', stageId: 'stg_xst_doing', status: 'in_progress' });
    expect((await patch('task_xst_move', { status: 'review' })).status).toBe(200);
    expect(await row('task_xst_move')).toMatchObject({ status: 'review', stageId: 'stg_xst_review' });
  });

  it('stores the legacy in_review as review', async () => {
    await seedTask({ id: 'task_xst_legacy', stageId: 'stg_xst_todo', status: 'todo' });
    expect((await patch('task_xst_legacy', { status: 'in_review' })).status).toBe(200);
    expect(await row('task_xst_legacy')).toMatchObject({ status: 'review', stageId: 'stg_xst_review' });
  });

  it('takes the status from a stage change and stamps completedDate on done', async () => {
    await seedTask({ id: 'task_xst_stage', stageId: 'stg_xst_review', status: 'review' });
    expect((await patch('task_xst_stage', { stageId: 'stg_xst_done' })).status).toBe(200);
    const done = await row('task_xst_stage');
    expect(done).toMatchObject({ status: 'done', stageId: 'stg_xst_done' });
    expect(done?.completedDate).not.toBeNull();
  });

  it('a review filter also finds rows still on in_review', async () => {
    await seedTask({ id: 'task_xst_f_new', status: 'review' });
    await seedTask({ id: 'task_xst_f_old', status: 'in_review' });
    const res = await request('/v1/tasks?projectId=proj_xst&status=review&limit=200');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(expect.arrayContaining(['task_xst_f_new', 'task_xst_f_old']));
  });
});

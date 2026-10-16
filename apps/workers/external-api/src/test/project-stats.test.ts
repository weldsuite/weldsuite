/**
 * /v1/projects and /v1/milestones return counters computed on read (the stored
 * columns are never maintained), with the same definitions as flow-api's
 * `@weldsuite/flow-domain/project-stats`. The mcp-server's copies of these
 * routes are identical.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

let db: Database;

const request = (path: string) => {
  const { app, env } = createExternalTestApp({
    scopes: ['projects:read', 'milestones:read'],
    tenantDb: db,
  });
  return app.request(path, undefined, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.projects).values({
    id: 'proj_xstat',
    name: 'Stats',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.projects.$inferInsert);
  await db.insert(schema.milestones).values([
    { id: 'ms_xstat_done', projectId: 'proj_xstat', name: 'Done', status: 'completed', dueDate: now },
    { id: 'ms_xstat_open', projectId: 'proj_xstat', name: 'Open', status: 'pending', dueDate: now },
  ] as (typeof schema.milestones.$inferInsert)[]);
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, projectId: 'proj_xstat', title: id, status, ...extra }) as typeof schema.tasks.$inferInsert;
  await db.insert(schema.tasks).values([
    task('task_xstat_1', 'done', { milestoneId: 'ms_xstat_open' }),
    task('task_xstat_2', 'todo', { milestoneId: 'ms_xstat_open' }),
    task('task_xstat_3', 'in_progress'),
    task('task_xstat_4', 'cancelled'),
    task('task_xstat_5', 'done', { deletedAt: now }),
  ]);
  await db.insert(schema.timeEntries).values([
    { id: 'te_xstat_1', projectId: 'proj_xstat', userId: 'u', date: '2026-01-01', duration: '90', status: 'approved' },
    { id: 'te_xstat_2', projectId: 'proj_xstat', userId: 'u', date: '2026-01-01', duration: '30', status: 'rejected' },
  ] as (typeof schema.timeEntries.$inferInsert)[]);
}, 60_000);

describe('/v1/projects + /v1/milestones · counters computed on read', () => {
  const expected = {
    totalTasks: 4,
    completedTasks: 1,
    openTasks: 2,
    totalMilestones: 2,
    completedMilestones: 1,
    progress: '33.33',
    actualHours: '1.50',
  };

  it('GET /v1/projects/:id overlays the computed counters', async () => {
    const res = await request('/v1/projects/proj_xstat');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject(expected);
  });

  it('GET /v1/projects overlays them on every listed project', async () => {
    const res = await request('/v1/projects');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.find((p) => p.id === 'proj_xstat')).toMatchObject(expected);
  });

  it('GET /v1/milestones/:id and the list compute task counters and progress', async () => {
    const one = await request('/v1/milestones/ms_xstat_open');
    expect(((await one.json()) as { data: unknown }).data).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      progress: '50.00',
    });

    const listed = await request('/v1/milestones?projectId=proj_xstat');
    const { data } = (await listed.json()) as { data: Array<{ id: string; progress: string; totalTasks: number }> };
    // A completed milestone without countable tasks reads 100.
    expect(data.find((m) => m.id === 'ms_xstat_done')).toMatchObject({ totalTasks: 0, progress: '100.00' });
    expect(data.find((m) => m.id === 'ms_xstat_open')).toMatchObject({ totalTasks: 2, progress: '50.00' });
  });
});

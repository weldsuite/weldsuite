/**
 * TASK-787: milestone totalTasks / completedTasks / progress are computed on
 * read from the milestone's tasks; the stored columns stay at their default 0.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { milestonesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

interface MilestoneStatsBody {
  id: string;
  totalTasks: number;
  completedTasks: number;
  progress: string;
}

function app() {
  return createTestApp('/api/milestones', milestonesRoutes, {
    context: { permissions: permissions('milestones:read', 'projects:scope:all'), tenantDb: db },
  });
}

async function seedProject(): Promise<string> {
  const id = generateId('prj');
  const now = new Date();
  await db.insert(schema.projects).values({ id, name: 'Milestone stats', createdAt: now, updatedAt: now });
  return id;
}

async function seedMilestone(projectId: string, status: string): Promise<string> {
  const id = generateId('ms');
  await db.insert(schema.milestones).values({
    id,
    projectId,
    name: `Milestone ${status}`,
    dueDate: new Date('2026-12-01T00:00:00Z'),
    status,
  });
  return id;
}

async function seedTask(
  projectId: string,
  milestoneId: string,
  status: string,
  deleted = false,
): Promise<void> {
  await db.insert(schema.tasks).values({
    id: generateId('task'),
    projectId,
    milestoneId,
    title: `Task ${status}`,
    status,
    deletedAt: deleted ? new Date() : null,
  });
}

describe('/api/milestones · computed counters (TASK-787)', () => {
  it('GET / and GET /:id return grouped task counts and progress', async () => {
    const projectId = await seedProject();
    const busy = await seedMilestone(projectId, 'in_progress');
    const emptyCompleted = await seedMilestone(projectId, 'completed');
    const emptyPending = await seedMilestone(projectId, 'pending');
    await seedTask(projectId, busy, 'done');
    await seedTask(projectId, busy, 'done');
    await seedTask(projectId, busy, 'todo');
    await seedTask(projectId, busy, 'cancelled');
    await seedTask(projectId, busy, 'done', true);
    const { request } = app();

    const listRes = await request(`/api/milestones?projectId=${projectId}`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: MilestoneStatsBody[] };
    const byId = new Map(listBody.data.map((m) => [m.id, m]));

    // 2 done / (4 total - 1 cancelled) = 66.67
    expect(byId.get(busy)).toMatchObject({ totalTasks: 4, completedTasks: 2 });
    expect(Number(byId.get(busy)?.progress)).toBeCloseTo(66.67, 2);
    expect(typeof byId.get(busy)?.progress).toBe('string');
    expect(Number(byId.get(emptyCompleted)?.progress)).toBe(100);
    expect(byId.get(emptyCompleted)).toMatchObject({ totalTasks: 0, completedTasks: 0 });
    expect(Number(byId.get(emptyPending)?.progress)).toBe(0);

    const detailRes = await request(`/api/milestones/${busy}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { data: MilestoneStatsBody };
    expect(detail.data).toMatchObject({ totalTasks: 4, completedTasks: 2 });
    expect(Number(detail.data.progress)).toBeCloseTo(66.67, 2);

    const emptyRes = await request(`/api/milestones/${emptyCompleted}`);
    const empty = (await emptyRes.json()) as { data: MilestoneStatsBody };
    expect(Number(empty.data.progress)).toBe(100);
  });
});

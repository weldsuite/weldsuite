/**
 * TASK-787: project counters (totalTasks, completedTasks, openTasks,
 * totalMilestones, completedMilestones, progress, actualHours) are computed on
 * read; the stored columns are never maintained and stay at their default 0.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { projectsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

interface ProjectStatsBody {
  id: string;
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  totalMilestones: number;
  completedMilestones: number;
  progress: string;
  actualHours: string;
}

function app() {
  return createTestApp('/api/projects', projectsRoutes, {
    context: { permissions: permissions('projects:read', 'tasks:read', 'projects:scope:all'), tenantDb: db },
  });
}

async function seedProject(name: string): Promise<string> {
  const id = generateId('prj');
  const now = new Date();
  await db.insert(schema.projects).values({ id, name, createdAt: now, updatedAt: now });
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
  status: string,
  opts: { milestoneId?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = generateId('task');
  await db.insert(schema.tasks).values({
    id,
    projectId,
    milestoneId: opts.milestoneId ?? null,
    title: `Task ${status}`,
    status,
    deletedAt: opts.deleted ? new Date() : null,
  });
  return id;
}

async function seedTime(
  projectId: string,
  minutes: number,
  opts: { status?: string; deleted?: boolean; taskId?: string } = {},
): Promise<void> {
  await db.insert(schema.timeEntries).values({
    id: generateId('te'),
    projectId,
    taskId: opts.taskId ?? null,
    userId: 'user_test',
    date: '2026-10-01',
    duration: String(minutes),
    status: opts.status ?? 'approved',
    deletedAt: opts.deleted ? new Date() : null,
  });
}

/** done / todo / cancelled + one soft-deleted task, 2 milestones, 90 + 30 min logged. */
async function seedPopulatedProject(): Promise<string> {
  const projectId = await seedProject('Populated');
  const doneMilestone = await seedMilestone(projectId, 'completed');
  const pendingMilestone = await seedMilestone(projectId, 'pending');
  await seedTask(projectId, 'done', { milestoneId: doneMilestone });
  await seedTask(projectId, 'todo', { milestoneId: pendingMilestone });
  await seedTask(projectId, 'cancelled');
  await seedTask(projectId, 'done', { deleted: true });
  await seedTime(projectId, 90);
  await seedTime(projectId, 30);
  await seedTime(projectId, 600, { status: 'rejected' });
  await seedTime(projectId, 600, { deleted: true });
  return projectId;
}

describe('/api/projects · computed counters (TASK-787)', () => {
  it('GET /:id derives task, milestone, progress and hours from the child rows', async () => {
    const projectId = await seedPopulatedProject();
    const { request } = app();

    const res = await request(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: ProjectStatsBody };

    expect(data.totalTasks).toBe(3);
    expect(data.completedTasks).toBe(1);
    expect(data.openTasks).toBe(1);
    // 1 done / (3 total - 1 cancelled)
    expect(Number(data.progress)).toBe(50);
    expect(data.totalMilestones).toBe(2);
    expect(data.completedMilestones).toBe(1);
    // 90 + 30 minutes; rejected and soft-deleted entries are ignored
    expect(Number(data.actualHours)).toBe(2);
    expect(typeof data.progress).toBe('string');
    expect(typeof data.actualHours).toBe('string');
  });

  it('reads 100 when every non-cancelled task is done', async () => {
    const projectId = await seedProject('All done');
    await seedTask(projectId, 'done');
    await seedTask(projectId, 'cancelled');
    const { request } = app();

    const res = await request(`/api/projects/${projectId}`);
    const { data } = (await res.json()) as { data: ProjectStatsBody };
    expect(Number(data.progress)).toBe(100);
    expect(data.openTasks).toBe(0);
  });

  it('GET / overlays the stats on every list row; an empty project is 0, not NaN', async () => {
    const populatedId = await seedPopulatedProject();
    const emptyId = await seedProject('Empty');
    const { request } = app();

    const res = await request('/api/projects?limit=100');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ProjectStatsBody[] };
    const populated = body.data.find((p) => p.id === populatedId);
    const empty = body.data.find((p) => p.id === emptyId);

    expect(populated).toMatchObject({
      totalTasks: 3,
      completedTasks: 1,
      openTasks: 1,
      totalMilestones: 2,
      completedMilestones: 1,
    });
    expect(Number(populated?.progress)).toBe(50);
    expect(Number(populated?.actualHours)).toBe(2);

    expect(empty).toMatchObject({
      totalTasks: 0,
      completedTasks: 0,
      openTasks: 0,
      totalMilestones: 0,
      completedMilestones: 0,
    });
    expect(Number(empty?.progress)).toBe(0);
    expect(Number(empty?.actualHours)).toBe(0);
    expect(Number.isNaN(Number(empty?.progress))).toBe(false);
  });

  it('GET /:id/gantt/milestones returns grouped task counts per milestone', async () => {
    const projectId = await seedProject('Gantt');
    const withTasks = await seedMilestone(projectId, 'in_progress');
    const emptyCompleted = await seedMilestone(projectId, 'completed');
    const emptyPending = await seedMilestone(projectId, 'pending');
    await seedTask(projectId, 'done', { milestoneId: withTasks });
    await seedTask(projectId, 'in_progress', { milestoneId: withTasks });
    await seedTask(projectId, 'cancelled', { milestoneId: withTasks });
    await seedTask(projectId, 'done', { milestoneId: withTasks, deleted: true });
    const { request } = app();

    const res = await request(`/api/projects/${projectId}/gantt/milestones`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; totalTasks: number; completedTasks: number; progress: string }>;
    };
    const byId = new Map(body.data.map((m) => [m.id, m]));

    expect(byId.get(withTasks)).toMatchObject({ totalTasks: 3, completedTasks: 1 });
    expect(Number(byId.get(withTasks)?.progress)).toBe(50);
    expect(byId.get(emptyCompleted)).toMatchObject({ totalTasks: 0, completedTasks: 0 });
    expect(Number(byId.get(emptyCompleted)?.progress)).toBe(100);
    expect(Number(byId.get(emptyPending)?.progress)).toBe(0);
  });
});

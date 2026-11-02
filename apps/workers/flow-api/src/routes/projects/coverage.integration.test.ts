/**
 * The project and project-member routes the other test files do not reach:
 * search, Gantt tasks, one project's workload, task import jobs (start and
 * status), and the member list, available users, stats and by-id reads.
 * Each with its refusals. Runs against the TypeScript worker and, in
 * conformance mode, the Rust backend (rust/conformance/suites.json).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { projectsRoutes } from './index';
import { projectMembersRoutes } from '../project-members';

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/projects', projectsRoutes);
router.route('/project-members', projectMembersRoutes);

const PROJECT = 'prj_cov_one';
const EMPTY_PROJECT = 'prj_cov_empty';
const MANAGER = 'user_cov_manager';
const MEMBER = 'user_cov_member';
const OUTSIDER = 'user_cov_outsider';
const SPARE = 'user_cov_spare';

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[], env: Partial<Env> = {}): Send {
  const { request } = createTestApp('/api', router, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
    env,
  });
  return (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const READ = ['projects:read', 'tasks:read'];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = new Date('2026-03-01T10:00:00.000Z');
  await db.insert(schema.projects).values([
    {
      id: PROJECT,
      name: 'Coverage Alpha',
      description: 'The alpha rollout',
      code: 'ALPHA',
      projectManagerId: MANAGER,
      createdAt: created,
      updatedAt: created,
    },
    { id: EMPTY_PROJECT, name: 'Coverage Beta', projectManagerId: MANAGER, createdAt: created, updatedAt: created },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_cov_manager', userId: MANAGER, name: 'Mia Manager', email: 'mia@example.com', status: 'ACTIVE', hoursPerWeek: '32' },
    { id: 'wm_cov_member', userId: MEMBER, name: 'Max Member', email: 'max@example.com', status: 'ACTIVE' },
    { id: 'wm_cov_spare', userId: SPARE, name: 'Sam Spare', email: 'sam@example.com', status: 'ACTIVE' },
  ]);
  await db.insert(schema.projectMembers).values([
    {
      id: 'pm_cov_manager',
      projectId: PROJECT,
      userId: MANAGER,
      role: 'owner',
      isActive: true,
      allocationPercentage: '50',
      hourlyRate: '90.00',
      createdAt: created,
      updatedAt: created,
      joinedAt: created,
    },
    {
      id: 'pm_cov_member',
      projectId: PROJECT,
      userId: MEMBER,
      role: 'member',
      isActive: true,
      hourlyRate: '45.00',
      createdAt: created,
      updatedAt: created,
      joinedAt: created,
    },
  ]);
  await db.insert(schema.tasks).values([
    {
      id: 'task_cov_one',
      projectId: PROJECT,
      title: 'Design the rollout',
      status: 'in_progress',
      assigneeId: MEMBER,
      estimatedHours: '6.50',
      startDate: new Date('2026-03-02T09:00:00.000Z'),
      dueDate: new Date('2026-03-05T17:00:00.000Z'),
      dependsOn: [],
    },
    {
      id: 'task_cov_two',
      projectId: PROJECT,
      title: 'Ship the rollout',
      status: 'todo',
      assigneeId: MANAGER,
      startDate: new Date('2026-03-06T09:00:00.000Z'),
    },
    { id: 'task_cov_done', projectId: PROJECT, title: 'Kick-off', status: 'done', assigneeId: MEMBER },
  ]);
}, 60_000);

describe('GET /api/projects/search', () => {
  it('finds projects by name, description or code, newest name first', async () => {
    const res = await as(MANAGER, READ)('GET', '/projects/search?q=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; totalTasks: number }> };
    expect(body.data.map((p) => p.id)).toEqual([PROJECT]);
    expect(body.data[0]?.totalTasks).toBe(3);
  });

  it('lists every accessible project without a term', async () => {
    const res = await as(MANAGER, READ)('GET', '/projects/search');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((p) => p.id)).toEqual([EMPTY_PROJECT, PROJECT]);
  });

  it('answers an empty list to someone without projects', async () => {
    const res = await as(OUTSIDER, READ)('GET', '/projects/search?q=alpha');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe('GET /api/projects/:id/gantt/tasks', () => {
  it('lists the tasks in start order', async () => {
    const res = await as(MEMBER, READ)('GET', `/projects/${PROJECT}/gantt/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).toEqual(['task_cov_one', 'task_cov_two', 'task_cov_done']);
  });

  it('refuses a non-member', async () => {
    const res = await as(OUTSIDER, READ)('GET', `/projects/${PROJECT}/gantt/tasks`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/projects/:id/workload', () => {
  it('groups the open, assigned tasks per member', async () => {
    const res = await as(MANAGER, READ)('GET', `/projects/${PROJECT}/workload`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { totalTasks: number; teamMembers: Array<{ userId: string; capacity: number; tasks: unknown[] }> };
    };
    expect(data.totalTasks).toBe(2);
    expect(data.teamMembers.find((m) => m.userId === MANAGER)?.capacity).toBe(16);
  });

  it('404s on a missing project a scope:all holder may ask for', async () => {
    const res = await as(OUTSIDER, [...READ, 'projects:scope:all'])('GET', '/projects/prj_cov_missing/workload');
    expect(res.status).toBe(404);
  });
});

describe('task import jobs', () => {
  const env = () => ({
    STORAGE: createMemoryR2(),
    IMPORT_TASKS: { create: async ({ id }: { id: string }) => ({ id }) },
  }) as unknown as Partial<Env>;

  it('validates the payload', async () => {
    const res = await as(MANAGER, ['tasks:create'], env())('POST', `/projects/${PROJECT}/tasks/import-jobs`, {
      tasks: [],
    });
    expect(res.status).toBe(400);
  });

  it('404s on a missing project', async () => {
    const res = await as(OUTSIDER, ['tasks:create', 'projects:scope:all'], env())(
      'POST',
      '/projects/prj_cov_missing/tasks/import-jobs',
      { tasks: [{ title: 'One' }] },
    );
    expect(res.status).toBe(404);
  });

  it('starts a job and reports its status', async () => {
    const send = as(MANAGER, ['tasks:create'], env());
    const res = await send('POST', `/projects/${PROJECT}/tasks/import-jobs`, {
      tasks: [{ title: 'Imported one' }, { title: '' }],
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { jobId: string; total: number; status: string } };
    expect(data.total).toBe(2);

    const status = await send('GET', `/projects/${PROJECT}/tasks/import-jobs/${data.jobId}`);
    expect(status.status).toBe(200);
    const job = (await status.json()) as { data: { jobId: string; total: number } };
    expect(job.data.jobId).toBe(data.jobId);
  });

  it('404s on an unknown job, and refuses a non-member', async () => {
    expect((await as(MANAGER, ['tasks:create'])('GET', `/projects/${PROJECT}/tasks/import-jobs/timp_missing`)).status).toBe(404);
    expect((await as(OUTSIDER, ['tasks:create'])('GET', `/projects/${PROJECT}/tasks/import-jobs/timp_missing`)).status).toBe(403);
  });
});

describe('/api/project-members reads', () => {
  it('lists the members with their profile; the rate only for admins and oneself', async () => {
    const res = await as(MEMBER, READ)('GET', `/project-members?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ userId: string; hourlyRate: string | null; user: { name: string } }> };
    expect(body.data.find((m) => m.userId === MANAGER)?.hourlyRate).toBeNull();
    expect(body.data.find((m) => m.userId === MEMBER)?.hourlyRate).toBe('45.00');
  });

  it('needs a projectId', async () => {
    expect((await as(MEMBER, READ)('GET', '/project-members')).status).toBe(400);
    expect((await as(MEMBER, READ)('GET', '/project-members/available')).status).toBe(400);
  });

  it('lists the workspace users not on the project', async () => {
    const res = await as(MANAGER, READ)('GET', `/project-members/available?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((u) => u.id)).toEqual([SPARE]);
    expect((await as(OUTSIDER, READ)('GET', `/project-members/available?projectId=${PROJECT}`)).status).toBe(403);
  });

  it('answers the member stats placeholder', async () => {
    const res = await as(MEMBER, READ)('GET', `/project-members/by-user/${PROJECT}/${MEMBER}/stats`);
    expect(res.status).toBe(200);
  });

  it('reads a member by row id', async () => {
    const res = await as(MANAGER, READ)('GET', '/project-members/pm_cov_member');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { hourlyRate: string } }).data.hourlyRate).toBe('45.00');
    expect((await as(OUTSIDER, READ)('GET', '/project-members/pm_cov_member')).status).toBe(403);
    expect((await as(MANAGER, READ)('GET', '/project-members/pm_cov_missing')).status).toBe(404);
  });

  it('404s by-user on someone not on the project', async () => {
    const res = await as(MANAGER, READ)('GET', `/project-members/by-user/${PROJECT}/${SPARE}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/workload/overview', () => {
  it('aggregates the open work of every accessible project', async () => {
    const res = await as(MANAGER, READ)('GET', '/projects/workload/overview');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { totalProjects: number; teamMembers: unknown[] } };
    expect(data.totalProjects).toBe(2);
    expect(data.teamMembers.length).toBeGreaterThan(0);
  });

  it('answers the empty overview to someone without projects', async () => {
    const res = await as(OUTSIDER, READ)('GET', '/projects/workload/overview');
    expect(res.status).toBe(200);
  });
});

describe('/api/project-members writes', () => {
  const WRITE = ['projects:read', 'projects:update', 'projects:delete'];

  it('adds a workspace member, and refuses a second add, a stranger and a non-manager', async () => {
    const add = (userId: string, body: Record<string, unknown>) =>
      as(userId, WRITE)('POST', '/project-members', { projectId: EMPTY_PROJECT, ...body });

    const res = await add(MANAGER, { userId: SPARE, role: 'member', allocationPercentage: 25, hourlyRate: '60' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { id: string } }).data.id).toMatch(/^pmem_/);
    expect((await add(MANAGER, { userId: SPARE })).status).toBe(400);
    expect((await add(MANAGER, { userId: 'user_cov_not_in_workspace' })).status).toBe(400);
    expect((await add(MEMBER, { userId: MEMBER })).status).toBe(403);
    expect((await add(MANAGER, { userId: MEMBER, role: 'boss' })).status).toBe(400);
  });

  it('updates a member by user, and keeps the last owner', async () => {
    const send = as(MANAGER, WRITE);
    const res = await send('PATCH', `/project-members/by-user/${EMPTY_PROJECT}/${SPARE}`, {
      role: 'admin',
      hourlyRate: 75,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { role: string } }).data.role).toBe('admin');
    expect((await send('PATCH', `/project-members/by-user/${EMPTY_PROJECT}/${OUTSIDER}`, { role: 'member' })).status).toBe(
      404,
    );
    expect(
      (await as(MEMBER, WRITE)('PATCH', `/project-members/by-user/${PROJECT}/${MANAGER}`, { role: 'member' })).status,
    ).toBe(403);
    expect((await send('PATCH', `/project-members/by-user/${PROJECT}/${MANAGER}`, { role: 'member' })).status).toBe(409);
  });

  it('removes a member by user, and keeps the last owner', async () => {
    const send = as(MANAGER, WRITE);
    expect((await send('DELETE', `/project-members/by-user/${EMPTY_PROJECT}/${SPARE}`)).status).toBe(204);
    expect((await send('DELETE', `/project-members/by-user/${EMPTY_PROJECT}/${SPARE}`)).status).toBe(404);
    expect((await as(MEMBER, WRITE)('DELETE', `/project-members/by-user/${PROJECT}/${MANAGER}`)).status).toBe(403);
    expect((await send('DELETE', `/project-members/by-user/${PROJECT}/${MANAGER}`)).status).toBe(409);
  });
});

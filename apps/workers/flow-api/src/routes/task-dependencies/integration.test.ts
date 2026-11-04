/**
 * DB-backed integration tests for typed task dependencies (delivery,
 * scheduling): /api/task-dependencies. Runs against the TypeScript worker and,
 * in conformance mode, the Rust backend (rust/conformance/suites.json), so
 * every status code, message and event payload asserted here is the contract
 * of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { taskDependenciesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_dep_manager';
const MEMBER = 'user_dep_member';
const VIEWER = 'user_dep_viewer';
const OUTSIDER = 'user_dep_outsider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/task-dependencies', taskDependenciesRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/task-dependencies${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const manager = () => as(MANAGER);

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

interface Dependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
  type: string;
  lagDays: number;
  createdBy: string;
}

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);

/**
 * The id a create answered, as the create's events carry it. In conformance
 * mode the spy records the TypeScript run (rolled back) and the answer is
 * Rust's, so the two mint different ids: only the prefix is the same.
 */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function seedTask(id: string, projectId: string | null, extra: Record<string, unknown> = {}) {
  await db.insert(schema.tasks).values({ id, title: `Task ${id}`, projectId, ...extra } as typeof schema.tasks.$inferInsert);
}

async function link(predecessorId: string, successorId: string, body: Record<string, unknown> = {}, who: Send = manager()): Promise<Dependency> {
  const res = await who('POST', '', { predecessorId, successorId, ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Dependency>(res);
}

const taskRow = async (id: string) => {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
};

// ── Create ──────────────────────────────────────────────────────────────────

describe('POST /', () => {
  it('links two tasks as finish-to-start with no lag, and keeps their dependency arrays in step', async () => {
    await seedProject('prj_dep_new');
    await seedTask('task_dep_new_a', 'prj_dep_new');
    await seedTask('task_dep_new_b', 'prj_dep_new');

    const created = await link('task_dep_new_a', 'task_dep_new_b');

    expect(created).toMatchObject({
      projectId: 'prj_dep_new',
      predecessorId: 'task_dep_new_a',
      successorId: 'task_dep_new_b',
      type: 'fs',
      lagDays: 0,
      createdBy: MANAGER,
    });
    expect(created.id).toMatch(/^tdp_/);
    expect((await taskRow('task_dep_new_b'))?.dependsOn).toEqual(['task_dep_new_a']);
    expect((await taskRow('task_dep_new_a'))?.blocks).toEqual(['task_dep_new_b']);
  });

  it('takes a type and a lag, a lead included', async () => {
    await seedProject('prj_dep_typed');
    await seedTask('task_dep_typed_a', 'prj_dep_typed');
    await seedTask('task_dep_typed_b', 'prj_dep_typed');
    await seedTask('task_dep_typed_c', 'prj_dep_typed');

    const ss = await link('task_dep_typed_a', 'task_dep_typed_b', { type: 'ss', lagDays: 2 });
    const lead = await link('task_dep_typed_a', 'task_dep_typed_c', { type: 'ff', lagDays: -3 });

    expect([ss.type, ss.lagDays, lead.type, lead.lagDays]).toEqual(['ss', 2, 'ff', -3]);
  });

  it('publishes task_dependency.created and one project_task.updated for each task it touched', async () => {
    await seedProject('prj_dep_events');
    await seedTask('task_dep_ev_a', 'prj_dep_events');
    await seedTask('task_dep_ev_b', 'prj_dep_events');

    const created = await link('task_dep_ev_a', 'task_dep_ev_b', { type: 'ss', lagDays: 1 });

    expect(actions()).toEqual(['task_dependency.created', 'project_task.updated', 'project_task.updated']);
    expect(events()[0]).toEqual({
      entityType: 'task_dependency',
      action: 'created',
      entityId: minted(created.id),
      data: {
        id: minted(created.id),
        projectId: 'prj_dep_events',
        predecessorId: 'task_dep_ev_a',
        successorId: 'task_dep_ev_b',
        type: 'ss',
        lagDays: 1,
      },
    });
    expect(events()[1].entityId).toBe('task_dep_ev_a');
    expect(events()[2].entityId).toBe('task_dep_ev_b');
  });

  it('refuses a body with an unknown field, a bad type or a lag out of range', async () => {
    await seedProject('prj_dep_body');
    await seedTask('task_dep_body_a', 'prj_dep_body');
    await seedTask('task_dep_body_b', 'prj_dep_body');
    const base = { predecessorId: 'task_dep_body_a', successorId: 'task_dep_body_b' };
    for (const extra of [{ id: 'tdp_x' }, { type: 'xx' }, { lagDays: 3651 }, { lagDays: 1.5 }, { projectId: 'prj_dep_body' }]) {
      const res = await manager()('POST', '', { ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect((await manager()('POST', '', { predecessorId: 'task_dep_body_a' })).status).toBe(400);
    expect(published).not.toHaveBeenCalled();
  });

  it('refuses a task linked to itself', async () => {
    await seedProject('prj_dep_self');
    await seedTask('task_dep_self', 'prj_dep_self');
    const res = await manager()('POST', '', { predecessorId: 'task_dep_self', successorId: 'task_dep_self' });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('A task cannot depend on itself');
  });

  it('answers 404 for a task that does not exist or is deleted, the predecessor first', async () => {
    await seedProject('prj_dep_404');
    await seedTask('task_dep_404_a', 'prj_dep_404');
    await seedTask('task_dep_404_gone', 'prj_dep_404', { deletedAt: new Date() });

    const noPredecessor = await manager()('POST', '', { predecessorId: 'task_dep_ghost', successorId: 'task_dep_404_a' });
    expect(noPredecessor.status).toBe(404);
    expect((await errorOf(noPredecessor)).message).toContain('task_dep_ghost');
    const noSuccessor = await manager()('POST', '', { predecessorId: 'task_dep_404_a', successorId: 'task_dep_404_gone' });
    expect(noSuccessor.status).toBe(404);
    expect((await errorOf(noSuccessor)).message).toContain('task_dep_404_gone');
    const both = await manager()('POST', '', { predecessorId: 'task_dep_ghost', successorId: 'task_dep_404_gone' });
    expect((await errorOf(both)).message).toContain('task_dep_ghost');
  });

  it('refuses tasks without a project, and tasks of two projects', async () => {
    await seedProject('prj_dep_x1');
    await seedProject('prj_dep_x2');
    await seedTask('task_dep_x1', 'prj_dep_x1');
    await seedTask('task_dep_x2', 'prj_dep_x2');
    await seedTask('task_dep_personal', null);

    const personal = await manager()('POST', '', { predecessorId: 'task_dep_x1', successorId: 'task_dep_personal' });
    expect(personal.status).toBe(400);
    expect((await errorOf(personal)).message).toBe('Both tasks must belong to a project');

    const crossing = await manager()('POST', '', { predecessorId: 'task_dep_x1', successorId: 'task_dep_x2' });
    expect(crossing.status).toBe(400);
    expect((await errorOf(crossing)).message).toBe('Both tasks must belong to the same project');
    expect(await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, 'prj_dep_x1'))).toEqual([]);
  });

  it('refuses a second link between the same two tasks', async () => {
    await seedProject('prj_dep_dup');
    await seedTask('task_dep_dup_a', 'prj_dep_dup');
    await seedTask('task_dep_dup_b', 'prj_dep_dup');
    await link('task_dep_dup_a', 'task_dep_dup_b');
    published.mockClear();

    const again = await manager()('POST', '', { predecessorId: 'task_dep_dup_a', successorId: 'task_dep_dup_b', type: 'ss' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('These tasks are already linked');
    expect(published).not.toHaveBeenCalled();
  });

  it('refuses a link that would close a cycle, through rows and through the old arrays', async () => {
    await seedProject('prj_dep_cycle');
    await seedTask('task_dep_cy_a', 'prj_dep_cycle');
    await seedTask('task_dep_cy_b', 'prj_dep_cycle');
    await seedTask('task_dep_cy_c', 'prj_dep_cycle');
    await link('task_dep_cy_a', 'task_dep_cy_b');
    await link('task_dep_cy_b', 'task_dep_cy_c');

    const direct = await manager()('POST', '', { predecessorId: 'task_dep_cy_b', successorId: 'task_dep_cy_a' });
    expect(direct.status).toBe(400);
    expect((await errorOf(direct)).message).toBe('Circular dependency detected');
    const transitive = await manager()('POST', '', { predecessorId: 'task_dep_cy_c', successorId: 'task_dep_cy_a' });
    expect(transitive.status).toBe(400);
    expect((await errorOf(transitive)).message).toBe('Circular dependency detected');

    // A chain only the arrays know (written before the table existed) counts too.
    await seedTask('task_dep_cy_d', 'prj_dep_cycle', { dependsOn: ['task_dep_cy_e'] });
    await seedTask('task_dep_cy_e', 'prj_dep_cycle');
    const legacy = await manager()('POST', '', { predecessorId: 'task_dep_cy_d', successorId: 'task_dep_cy_e' });
    expect(legacy.status).toBe(400);
    expect((await errorOf(legacy)).message).toBe('Circular dependency detected');
  });

  it('lets a project member write it and a viewer or outsider not, and a missing permission is a 403', async () => {
    await seedProject('prj_dep_acl');
    await seedTask('task_dep_acl_a', 'prj_dep_acl');
    await seedTask('task_dep_acl_b', 'prj_dep_acl');
    const body = { predecessorId: 'task_dep_acl_a', successorId: 'task_dep_acl_b' };

    const viewer = await as(VIEWER)('POST', '', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER)('POST', '', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', body)).status).toBe(403);
    expect(await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, 'prj_dep_acl'))).toEqual([]);

    expect((await as(MEMBER)('POST', '', body)).status).toBe(201);
  });

  it('checks the write access of both projects before it says the tasks are in two', async () => {
    await seedProject('prj_dep_acl1');
    await seedProject('prj_dep_acl2');
    await db.delete(schema.projectMembers).where(eq(schema.projectMembers.id, 'pm_prj_dep_acl2_m'));
    await seedTask('task_dep_acl1', 'prj_dep_acl1');
    await seedTask('task_dep_acl2', 'prj_dep_acl2');
    const res = await as(MEMBER)('POST', '', { predecessorId: 'task_dep_acl1', successorId: 'task_dep_acl2' });
    expect(res.status).toBe(403);
  });
});

// ── Update ──────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('changes the type and the lag, and publishes task_dependency.updated', async () => {
    await seedProject('prj_dep_patch');
    await seedTask('task_dep_p_a', 'prj_dep_patch');
    await seedTask('task_dep_p_b', 'prj_dep_patch');
    const created = await link('task_dep_p_a', 'task_dep_p_b');
    published.mockClear();

    const res = await manager()('PATCH', `/${created.id}`, { type: 'ff', lagDays: -2 });

    expect(res.status).toBe(200);
    expect(await data<Dependency>(res)).toMatchObject({ id: created.id, type: 'ff', lagDays: -2, predecessorId: 'task_dep_p_a', successorId: 'task_dep_p_b' });
    expect(events()).toEqual([
      {
        entityType: 'task_dependency',
        action: 'updated',
        entityId: created.id,
        data: { id: created.id, projectId: 'prj_dep_patch', predecessorId: 'task_dep_p_a', successorId: 'task_dep_p_b', type: 'ff', lagDays: -2 },
      },
    ]);
    // One of the two alone leaves the other as it was.
    const lagOnly = await manager()('PATCH', `/${created.id}`, { lagDays: 4 });
    expect(await data<Dependency>(lagOnly)).toMatchObject({ type: 'ff', lagDays: 4 });
    // The arrays are about who waits for whom, not how: untouched.
    expect((await taskRow('task_dep_p_b'))?.dependsOn).toEqual(['task_dep_p_a']);
  });

  it('answers 404, 403 and 400 in that order', async () => {
    await seedProject('prj_dep_patch2');
    await seedTask('task_dep_p2_a', 'prj_dep_patch2');
    await seedTask('task_dep_p2_b', 'prj_dep_patch2');
    const created = await link('task_dep_p2_a', 'task_dep_p2_b');

    expect((await manager()('PATCH', '/tdp_ghost', { type: 'ss' })).status).toBe(404);
    // A viewer with a bad body gets the 403, not the 400.
    expect((await as(VIEWER)('PATCH', `/${created.id}`, { type: 'nope' })).status).toBe(403);
    expect((await as(OUTSIDER)('PATCH', `/${created.id}`, { type: 'ss' })).status).toBe(403);
    for (const body of [{}, { type: 'xx' }, { lagDays: 9999 }, { id: 'tdp_x', type: 'ss' }]) {
      const res = await manager()('PATCH', `/${created.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${created.id}`, { type: 'ss' })).status).toBe(403);
    expect((await as(MEMBER)('PATCH', `/${created.id}`, { type: 'ss' })).status).toBe(200);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('removes the link and the arrays entries, and publishes the events', async () => {
    await seedProject('prj_dep_del');
    await seedTask('task_dep_d_a', 'prj_dep_del');
    await seedTask('task_dep_d_b', 'prj_dep_del');
    await seedTask('task_dep_d_c', 'prj_dep_del');
    const first = await link('task_dep_d_a', 'task_dep_d_b');
    await link('task_dep_d_a', 'task_dep_d_c');
    published.mockClear();

    const res = await manager()('DELETE', `/${first.id}`);

    expect(res.status).toBe(204);
    expect(await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.id, first.id))).toEqual([]);
    expect((await taskRow('task_dep_d_a'))?.blocks).toEqual(['task_dep_d_c']);
    expect((await taskRow('task_dep_d_b'))?.dependsOn).toEqual([]);
    expect(actions()).toEqual(['task_dependency.deleted', 'project_task.updated', 'project_task.updated']);
    expect(events()[0].data).toEqual({
      id: first.id,
      projectId: 'prj_dep_del',
      predecessorId: 'task_dep_d_a',
      successorId: 'task_dep_d_b',
      type: 'fs',
      lagDays: 0,
    });
  });

  it('answers 404 for a link that is gone, and 403 without write access', async () => {
    await seedProject('prj_dep_del2');
    await seedTask('task_dep_d2_a', 'prj_dep_del2');
    await seedTask('task_dep_d2_b', 'prj_dep_del2');
    const created = await link('task_dep_d2_a', 'task_dep_d2_b');

    expect((await manager()('DELETE', '/tdp_ghost')).status).toBe(404);
    expect((await as(VIEWER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('DELETE', `/${created.id}`)).status).toBe(403);
    expect(await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.id, created.id))).toHaveLength(1);
    expect((await manager()('DELETE', `/${created.id}`)).status).toBe(204);
    expect((await manager()('DELETE', `/${created.id}`)).status).toBe(404);
  });
});

// ── List ────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('lists the links of a project, newest first, with a cursor', async () => {
    await seedProject('prj_dep_list');
    for (const name of ['a', 'b', 'c', 'd']) await seedTask(`task_dep_l_${name}`, 'prj_dep_list');
    const first = await link('task_dep_l_a', 'task_dep_l_b');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await link('task_dep_l_b', 'task_dep_l_c');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await link('task_dep_l_c', 'task_dep_l_d', { type: 'sf', lagDays: 1 });

    const all = await manager()('GET', '?projectId=prj_dep_list');
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Dependency[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    expect(body.data[0]).toMatchObject({ type: 'sf', lagDays: 1 });

    const page = await manager()('GET', '?projectId=prj_dep_list&limit=2');
    const firstPage = (await page.json()) as { data: Dependency[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(firstPage.data.map((row) => row.id)).toEqual([third.id, second.id]);
    expect(firstPage.pagination.hasMore).toBe(true);
    expect(firstPage.pagination.totalCount).toBe(3);
    const rest = await manager()('GET', `?projectId=prj_dep_list&limit=2&cursor=${firstPage.pagination.cursor}`);
    const secondPage = (await rest.json()) as { data: Dependency[]; pagination: { hasMore: boolean } };
    expect(secondPage.data.map((row) => row.id)).toEqual([first.id]);
    expect(secondPage.pagination.hasMore).toBe(false);
  });

  it('lists the links of one task in both directions', async () => {
    await seedProject('prj_dep_task');
    for (const name of ['a', 'b', 'c', 'd']) await seedTask(`task_dep_t_${name}`, 'prj_dep_task');
    const into = await link('task_dep_t_a', 'task_dep_t_b');
    const out = await link('task_dep_t_b', 'task_dep_t_c');
    await link('task_dep_t_c', 'task_dep_t_d');

    const res = await manager()('GET', '?taskId=task_dep_t_b');
    const rows = await data<Dependency[]>(res);
    expect(rows.map((row) => row.id).sort()).toEqual([into.id, out.id].sort());
    const both = await manager()('GET', '?projectId=prj_dep_task&taskId=task_dep_t_d');
    expect((await data<Dependency[]>(both)).map((row) => row.predecessorId)).toEqual(['task_dep_t_c']);
  });

  it('wants a project or a task, a known task, and a project the caller is in', async () => {
    await seedProject('prj_dep_list2');
    await seedTask('task_dep_l2_a', 'prj_dep_list2');

    const neither = await manager()('GET', '');
    expect(neither.status).toBe(400);
    expect((await errorOf(neither)).message).toBe('Give projectId or taskId');
    const blank = await manager()('GET', '?projectId=');
    expect(blank.status).toBe(400);
    expect((await manager()('GET', '?taskId=task_dep_ghost')).status).toBe(404);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_dep_list2')).status).toBe(403);
    expect((await as(OUTSIDER)('GET', '?taskId=task_dep_l2_a')).status).toBe(403);
    expect((await as(MANAGER, [])('GET', '?projectId=prj_dep_list2')).status).toBe(403);
    // A viewer reads.
    expect((await as(VIEWER, ['projects:read'])('GET', '?projectId=prj_dep_list2')).status).toBe(200);
  });
});

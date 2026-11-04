/**
 * DB-backed integration tests for the project-control links (project control,
 * phase 1): /api/project-control-links. Runs against the TypeScript worker
 * and, in conformance mode, the Rust backend (rust/conformance/suites.json),
 * so every status code, message and event payload asserted here is the
 * contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTask } from '@weldsuite/flow-domain/tasks';
import type { Env, Variables } from '../../types';
import { projectRaidRoutes } from '../project-raid';
import { projectControlLinksRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/project-raid', projectRaidRoutes);
router.route('/project-control-links', projectControlLinksRoutes);

const MANAGER = 'user_link_manager';
const MEMBER = 'user_link_member';
const VIEWER = 'user_link_viewer';
const OUTSIDER = 'user_link_outsider';
const SCOPE_ALL = 'user_link_scope_all';
const OTHER_MANAGER = 'user_link_other_manager';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'tasks:create'];

const P1 = 'prj_link_1';
const P2 = 'prj_link_2';
const P3 = 'prj_link_3';

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api', router, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
  });
  return (method, path, body) =>
    request(`/api${path}`, {
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

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));

beforeEach(() => {
  published.mockClear();
});

const ids: Record<string, string> = {};

type Linked = {
  id: string;
  relation: string;
  direction: 'outgoing' | 'incoming';
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  projectId: string;
  target: { type: string; id: string; projectId: string; title: string; status: string; code: string | null; ownerId: string | null; dueDate: string | null };
};

const link = (fromType: string, fromId: string, toType: string, toId: string, relation: string) => ({
  fromType,
  fromId,
  toType,
  toId,
  relation,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values([
    { id: P1, name: 'Links one', projectManagerId: MANAGER, createdAt: at, updatedAt: at },
    { id: P2, name: 'Links two', projectManagerId: OTHER_MANAGER, createdAt: at, updatedAt: at },
    { id: P3, name: 'Links three', projectManagerId: MANAGER, createdAt: at, updatedAt: at },
  ]);
  await db.insert(schema.projectMembers).values([
    { id: 'pm_link_member', projectId: P1, userId: MEMBER, role: 'member', isActive: true, createdAt: at, updatedAt: at, joinedAt: at },
    { id: 'pm_link_viewer', projectId: P1, userId: VIEWER, role: 'viewer', isActive: true, createdAt: at, updatedAt: at, joinedAt: at },
  ]);
  await db.insert(schema.milestones).values([
    { id: 'ms_link_1', projectId: P1, name: 'Launch', dueDate: new Date('2026-12-31T00:00:00.000Z'), status: 'pending', createdAt: at, updatedAt: at },
    { id: 'ms_link_2', projectId: P2, name: 'Other launch', dueDate: new Date('2027-01-31T00:00:00.000Z'), status: 'pending', createdAt: at, updatedAt: at },
    { id: 'ms_link_3', projectId: P3, name: 'Third launch', dueDate: new Date('2027-02-28T00:00:00.000Z'), status: 'pending', createdAt: at, updatedAt: at },
    { id: 'ms_link_gone', projectId: P1, name: 'Soon deleted', dueDate: new Date('2027-03-31T00:00:00.000Z'), status: 'pending', createdAt: at, updatedAt: at },
  ]);

  const send = manager();
  const make = async (body: Record<string, unknown>) => (await data<{ id: string }>(await send('POST', '/project-raid', { projectId: P1, ...body }))).id;
  ids.risk = await make({ kind: 'risk', title: 'Supplier delivers late', probability: 3, impact: 3 });
  ids.risk2 = await make({ kind: 'risk', title: 'Key person leaves', probability: 2, impact: 4 });
  ids.issue = await make({ kind: 'issue', title: 'Build is red' });
  ids.dependency = await make({ kind: 'dependency', title: 'Design system', direction: 'inbound' });
  ids.assumption = await make({ kind: 'assumption', title: 'SSO is available' });
  for (const name of ['task1', 'task2', 'task3', 'task4']) {
    ids[name] = (await createTask(db, { title: `Task ${name}`, assigneeId: 'user_assignee', dueDate: '2026-12-05T00:00:00.000Z' }, { projectId: P1, userId: MANAGER })).row.id;
  }
  ids.personal = (await createTask(db, { title: 'Personal' }, { projectId: null, userId: MANAGER })).row.id;
  ids.otherTask = (await createTask(db, { title: 'Other project task' }, { projectId: P2, userId: OTHER_MANAGER })).row.id;
}, 60_000);

describe('POST /', () => {
  it('links a task to the risk it mitigates, and publishes the link', async () => {
    const res = await manager()('POST', '/project-control-links', link('task', ids.task1, 'raid_item', ids.risk, 'mitigates'));
    expect(res.status).toBe(201);
    const created = await data<Record<string, string>>(res);
    expect(created).toMatchObject({ projectId: P1, fromType: 'task', fromId: ids.task1, toType: 'raid_item', toId: ids.risk, relation: 'mitigates', createdBy: MANAGER });
    expect(created.id).toMatch(/^pcl_/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // In conformance mode the spy records the TypeScript run (rolled back) and
    // the answer is Rust's: the two mint different ids.
    const linkId = conformanceTarget() ? expect.stringMatching(/^pcl_/) : created.id;
    expect(events()).toEqual([
      {
        entityType: 'project_control_link',
        action: 'created',
        entityId: linkId,
        data: { id: linkId, projectId: P1, fromType: 'task', fromId: ids.task1, toType: 'raid_item', toId: ids.risk, relation: 'mitigates' },
      },
    ]);

    // The register counts it as progress, like a task made from the register.
    const detail = await data<{ taskProgress: { done: number; total: number } }>(await manager()('GET', `/project-raid/${ids.risk}`));
    expect(detail.taskProgress).toEqual({ done: 0, total: 1 });
  });

  it('links the other relations: resolves, raised_from, affects, threatens', async () => {
    const send = manager();
    for (const body of [
      link('task', ids.task2, 'raid_item', ids.issue, 'resolves'),
      link('raid_item', ids.issue, 'raid_item', ids.risk2, 'raised_from'),
      link('raid_item', ids.risk, 'task', ids.task3, 'affects'),
      link('raid_item', ids.risk, 'milestone', 'ms_link_1', 'threatens'),
      link('raid_item', ids.dependency, 'milestone', 'ms_link_gone', 'affects'),
    ]) {
      const res = await send('POST', '/project-control-links', body);
      expect(res.status, JSON.stringify(body)).toBe(201);
      // Links are listed oldest first; leave a gap so the order is not a tie.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  });

  it('refuses a second link between the same two objects, whatever the relation', async () => {
    const send = manager();
    const again = await send('POST', '/project-control-links', link('task', ids.task1, 'raid_item', ids.risk, 'mitigates'));
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('These objects are already linked');
    // The reverse is a different pair; the same pair with another relation is not.
    const other = await send('POST', '/project-control-links', link('raid_item', ids.risk, 'task', ids.task3, 'threatens'));
    expect(other.status).toBe(409);
    expect(events().filter((event) => event.action === 'created')).toHaveLength(0);
  });

  it('keeps each relation to its types', async () => {
    const send = manager();
    const refuse = async (body: ReturnType<typeof link>, message: string) => {
      const res = await send('POST', '/project-control-links', body);
      expect([res.status, (await errorOf(res)).message]).toEqual([400, message]);
    };
    await refuse(link('task', ids.task1, 'task', ids.task1, 'affects'), 'A link needs two different objects');
    await refuse(link('raid_item', ids.risk, 'task', ids.task1, 'mitigates'), "The 'mitigates' relation goes from a task to a register item");
    await refuse(link('task', ids.task1, 'milestone', 'ms_link_1', 'resolves'), "The 'resolves' relation goes from a task to a register item");
    await refuse(link('task', ids.task1, 'raid_item', ids.risk, 'raised_from'), "The 'raised_from' relation goes from a register item to the register item it was raised from");
    await refuse(link('raid_item', ids.risk, 'raid_item', ids.issue, 'affects'), "The 'affects' relation goes from a register item to a task, milestone, deliverable or benefit");
    await refuse(link('task', ids.task1, 'milestone', 'ms_link_1', 'threatens'), "The 'threatens' relation goes from a register item to a task, milestone, deliverable or benefit");
    // A task mitigates a risk and resolves an issue, nothing else.
    await refuse(link('task', ids.task3, 'raid_item', ids.issue, 'mitigates'), 'A task can only mitigate a risk');
    await refuse(link('task', ids.task3, 'raid_item', ids.risk2, 'resolves'), 'A task can only resolve an issue');
    await refuse(link('task', ids.task3, 'raid_item', ids.assumption, 'mitigates'), 'A task can only mitigate a risk');
  });

  it('rejects a bad body', async () => {
    const send = manager();
    const status = async (body: unknown) => (await send('POST', '/project-control-links', body)).status;
    const good = link('task', ids.task3, 'raid_item', ids.risk2, 'mitigates');
    expect(await status({ ...good, relation: 'blocks' })).toBe(400);
    expect(await status({ ...good, fromType: 'decision' })).toBe(400);
    expect(await status({ ...good, toId: '' })).toBe(400);
    expect(await status({ ...good, projectId: P1 })).toBe(400);
    expect(await status({ fromType: 'task', fromId: ids.task3 })).toBe(400);
    expect(await status('nope')).toBe(400);
  });

  it('answers 404 for an object that is missing, deleted or has no project', async () => {
    const send = manager();
    const missing = async (body: ReturnType<typeof link>, message: string) => {
      const res = await send('POST', '/project-control-links', body);
      expect([res.status, (await errorOf(res)).message]).toEqual([404, message]);
    };
    await missing(link('task', 'task_nope', 'raid_item', ids.risk2, 'mitigates'), "Task with ID 'task_nope' not found");
    await missing(link('task', ids.task3, 'raid_item', 'raid_nope', 'mitigates'), "RAID item with ID 'raid_nope' not found");
    await missing(link('raid_item', ids.risk2, 'milestone', 'ms_nope', 'threatens'), "Milestone with ID 'ms_nope' not found");
    await missing(link('task', ids.personal, 'raid_item', ids.risk2, 'mitigates'), `Task with ID '${ids.personal}' not found`);
  });

  it('wants write access to both ends and the permission', async () => {
    const body = link('task', ids.task3, 'raid_item', ids.risk2, 'mitigates');
    const viewer = await as(VIEWER)('POST', '/project-control-links', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER)('POST', '/project-control-links', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '/project-control-links', body)).status).toBe(403);
    expect((await as(MEMBER, ['projects:read', 'projects:update'])('POST', '/project-control-links', body)).status).toBe(201);
  });

  it('keeps both ends in one project, except a dependency on a milestone of a project the caller can write', async () => {
    const send = manager();
    const toOther = link('raid_item', ids.risk, 'milestone', 'ms_link_2', 'threatens');
    // The manager of P1 is not in P2: nothing is said about how the ends relate.
    const notInP2 = await send('POST', '/project-control-links', link('raid_item', ids.dependency, 'milestone', 'ms_link_2', 'threatens'));
    expect(notInP2.status).toBe(403);
    expect((await errorOf(notInP2)).message).toBe('You do not have write access to this project');
    // The other project's manager is not in P1.
    expect((await as(OTHER_MANAGER)('POST', '/project-control-links', toOther)).status).toBe(403);

    // Someone who can write both: a risk may not reach across, a dependency may.
    const risk = await as(SCOPE_ALL)('POST', '/project-control-links', toOther);
    expect([risk.status, (await errorOf(risk)).message]).toEqual([400, 'Both ends of a link must be in the same project']);
    const task = await as(SCOPE_ALL)('POST', '/project-control-links', link('task', ids.otherTask, 'raid_item', ids.risk2, 'mitigates'));
    expect([task.status, (await errorOf(task)).message]).toEqual([400, 'Both ends of a link must be in the same project']);

    // The manager of P1 also manages P3.
    const dependency = await send('POST', '/project-control-links', link('raid_item', ids.dependency, 'milestone', 'ms_link_3', 'threatens'));
    expect(dependency.status).toBe(201);
    expect(await data(dependency)).toMatchObject({ projectId: P1 });
    const crossProject = await as(SCOPE_ALL)('POST', '/project-control-links', link('raid_item', ids.dependency, 'milestone', 'ms_link_2', 'threatens'));
    expect(crossProject.status).toBe(201);
  });
});

describe('GET /', () => {
  it('lists the links of an object by its from end, with the object at the other end', async () => {
    const res = await manager()('GET', `/project-control-links?fromType=raid_item&fromId=${ids.risk}`);
    expect(res.status).toBe(200);
    const links = await data<Linked[]>(res);
    expect(links.map((entry) => [entry.relation, entry.direction, entry.toType, entry.toId])).toEqual([
      ['affects', 'outgoing', 'task', ids.task3],
      ['threatens', 'outgoing', 'milestone', 'ms_link_1'],
    ]);
    expect(links[0]?.target).toEqual({
      type: 'task',
      id: ids.task3,
      projectId: P1,
      title: 'Task task3',
      status: 'todo',
      code: null,
      ownerId: 'user_assignee',
      dueDate: '2026-12-05T00:00:00.000Z',
    });
    expect(links[1]?.target).toEqual({
      type: 'milestone',
      id: 'ms_link_1',
      projectId: P1,
      title: 'Launch',
      status: 'pending',
      code: null,
      ownerId: null,
      dueDate: '2026-12-31T00:00:00.000Z',
    });
  });

  it('lists them by the to end, seen from that object', async () => {
    const links = await data<Linked[]>(await manager()('GET', `/project-control-links?toType=raid_item&toId=${ids.risk}`));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ relation: 'mitigates', direction: 'incoming', fromType: 'task', fromId: ids.task1 });
    expect(links[0]?.target).toMatchObject({ type: 'task', id: ids.task1, title: 'Task task1' });

    const issue = await data<Linked[]>(await manager()('GET', `/project-control-links?toType=raid_item&toId=${ids.risk2}`));
    expect(issue[0]).toMatchObject({ relation: 'raised_from', direction: 'incoming', target: { type: 'raid_item', id: ids.issue, code: 'ISS-1', title: 'Build is red', status: 'open' } });
  });

  it('finds the link between two given objects', async () => {
    const both = await data<Linked[]>(
      await manager()('GET', `/project-control-links?fromType=task&fromId=${ids.task1}&toType=raid_item&toId=${ids.risk}`),
    );
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ relation: 'mitigates', direction: 'outgoing', target: { id: ids.risk, code: 'RSK-1' } });
    expect(await data(await manager()('GET', `/project-control-links?fromType=task&fromId=${ids.task1}&toType=raid_item&toId=${ids.issue}`))).toEqual([]);
  });

  it('is open to project viewers and closed to outsiders', async () => {
    const path = `/project-control-links?fromType=raid_item&fromId=${ids.risk}`;
    expect((await as(VIEWER)('GET', path)).status).toBe(200);
    const outsider = await as(OUTSIDER)('GET', path);
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await as(MANAGER, ['tasks:create'])('GET', path)).status).toBe(403);
  });

  it('wants the object to be named, whole', async () => {
    const send = manager();
    const message = async (query: string) => {
      const res = await send('GET', `/project-control-links${query}`);
      return [res.status, (await errorOf(res)).message];
    };
    expect(await message('')).toEqual([400, 'Give fromType and fromId, or toType and toId']);
    expect(await message('?fromType=task')).toEqual([400, 'fromType and fromId must be given together']);
    expect(await message(`?toId=${ids.risk}`)).toEqual([400, 'toType and toId must be given together']);
    expect((await send('GET', `/project-control-links?fromType=banana&fromId=x`)).status).toBe(400);
    expect((await send('GET', `/project-control-links?fromType=task&fromId=x&extra=1`)).status).toBe(400);
    const missing = await send('GET', '/project-control-links?fromType=task&fromId=task_nope');
    expect([missing.status, (await errorOf(missing)).message]).toEqual([404, "Task with ID 'task_nope' not found"]);
  });

  it("leaves out a link to an object in a project the caller cannot read", async () => {
    const path = `/project-control-links?fromType=raid_item&fromId=${ids.dependency}`;
    const own = await data<Linked[]>(await manager()('GET', path));
    expect(own.map((entry) => entry.toId)).toContain('ms_link_3');
    expect(own.map((entry) => entry.toId)).not.toContain('ms_link_2');
    const all = await data<Linked[]>(await as(SCOPE_ALL)('GET', path));
    expect(all.map((entry) => entry.toId)).toContain('ms_link_2');
    const detail = await data<{ links: Linked[] }>(await manager()('GET', `/project-raid/${ids.dependency}`));
    expect(detail.links.map((entry) => entry.toId)).not.toContain('ms_link_2');
  });

  it('leaves out a link whose other end was deleted', async () => {
    const send = manager();
    const before = await data<Linked[]>(await send('GET', `/project-control-links?fromType=raid_item&fromId=${ids.dependency}`));
    expect(before.map((entry) => entry.toId)).toContain('ms_link_gone');

    await db.update(schema.milestones).set({ deletedAt: new Date() }).where(eq(schema.milestones.id, 'ms_link_gone'));
    const after = await data<Linked[]>(await send('GET', `/project-control-links?fromType=raid_item&fromId=${ids.dependency}`));
    expect(after.map((entry) => entry.toId)).not.toContain('ms_link_gone');
    const detail = await data<{ links: Linked[] }>(await send('GET', `/project-raid/${ids.dependency}`));
    expect(detail.links.map((entry) => entry.toId)).not.toContain('ms_link_gone');
  });
});

describe('DELETE /:id', () => {
  it('removes a link and publishes it, and the same pair can be linked again', async () => {
    const send = manager();
    const created = await data<{ id: string }>(await send('POST', '/project-control-links', link('task', ids.task4, 'raid_item', ids.risk2, 'mitigates')));

    published.mockClear();
    const res = await send('DELETE', `/project-control-links/${created.id}`);
    expect(res.status).toBe(204);
    expect(events()).toEqual([
      {
        entityType: 'project_control_link',
        action: 'deleted',
        entityId: created.id,
        data: { id: created.id, projectId: P1, fromType: 'task', fromId: ids.task4, toType: 'raid_item', toId: ids.risk2, relation: 'mitigates' },
      },
    ]);
    expect(await data(await send('GET', `/project-control-links?fromType=task&fromId=${ids.task4}`))).toEqual([]);
    expect((await send('POST', '/project-control-links', link('task', ids.task4, 'raid_item', ids.risk2, 'mitigates'))).status).toBe(201);
  });

  it('answers 404 for a missing link, and wants write access to the project', async () => {
    const send = manager();
    const missing = await send('DELETE', '/project-control-links/pcl_nope');
    expect([missing.status, (await errorOf(missing)).message]).toEqual([404, "Link with ID 'pcl_nope' not found"]);

    const [existing] = await data<Linked[]>(await send('GET', `/project-control-links?toType=raid_item&toId=${ids.risk}`));
    const id = existing?.id as string;
    expect((await as(VIEWER)('DELETE', `/project-control-links/${id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/project-control-links/${id}`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('DELETE', `/project-control-links/${id}`)).status).toBe(403);
    expect((await as(MEMBER, ['projects:read', 'projects:update'])('DELETE', `/project-control-links/${id}`)).status).toBe(204);
  });

  it("wants write access to the other end's project too", async () => {
    const [cross] = (await data<Linked[]>(await as(SCOPE_ALL)('GET', `/project-control-links?fromType=raid_item&fromId=${ids.dependency}`))).filter(
      (entry) => entry.toId === 'ms_link_2',
    );
    const id = cross?.id as string;
    expect(id).toBeDefined();
    const refused = await manager()('DELETE', `/project-control-links/${id}`);
    expect(refused.status).toBe(403);
    expect((await as(SCOPE_ALL)('DELETE', `/project-control-links/${id}`)).status).toBe(204);
  });
});

describe('links follow their objects', () => {
  it('go with a register item that is deleted', async () => {
    const send = manager();
    const made = await data<{ id: string }>(await send('POST', '/project-raid', { kind: 'risk', projectId: P1, title: 'Short lived', probability: 1, impact: 1 }));
    await send('POST', '/project-control-links', link('raid_item', made.id, 'milestone', 'ms_link_1', 'threatens'));
    expect(await data<Linked[]>(await send('GET', `/project-control-links?fromType=raid_item&fromId=${made.id}`))).toHaveLength(1);

    expect((await send('DELETE', `/project-raid/${made.id}`)).status).toBe(204);
    const rows = await db.select().from(schema.projectControlLinks).where(eq(schema.projectControlLinks.fromId, made.id));
    expect(rows).toEqual([]);
  });
});

describe('governance objects', () => {
  const seedGovernance = async () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDecisions).values({ id: 'dec_link_1', projectId: P1, number: 7, title: 'Keep legacy read-only', status: 'decided', createdBy: MANAGER, createdAt: at, updatedAt: at });
    await db.insert(schema.projectChangeRequests).values({ id: 'cr_link_1', projectId: P1, number: 6, title: 'Hosting', status: 'approved', createdBy: MANAGER, createdAt: at, updatedAt: at });
    await db.insert(schema.projectDeliverables).values({ id: 'del_link_1', projectId: P1, number: 6, title: 'Read-only mode', createdBy: MANAGER, createdAt: at, updatedAt: at });
    await db.insert(schema.projectBenefits).values({ id: 'ben_link_1', projectId: P1, number: 3, title: 'Licence cost removed', createdBy: MANAGER, createdAt: at, updatedAt: at });
  };

  it('links decisions, change requests, deliverables and benefits with implements, decided_by, affects and threatens', async () => {
    await seedGovernance();
    const send = manager();
    const make = async (body: ReturnType<typeof link>) => {
      const res = await send('POST', '/project-control-links', body);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
      return data<{ id: string }>(res);
    };
    await make(link('change_request', 'cr_link_1', 'decision', 'dec_link_1', 'decided_by'));
    await make(link('benefit', 'ben_link_1', 'decision', 'dec_link_1', 'decided_by'));
    await make(link('deliverable', 'del_link_1', 'decision', 'dec_link_1', 'decided_by'));
    await make(link('raid_item', ids.risk, 'decision', 'dec_link_1', 'decided_by'));
    await make(link('task', ids.task1, 'change_request', 'cr_link_1', 'implements'));
    await make(link('deliverable', 'del_link_1', 'benefit', 'ben_link_1', 'implements'));
    await make(link('raid_item', ids.risk, 'deliverable', 'del_link_1', 'affects'));
    await make(link('raid_item', ids.risk, 'benefit', 'ben_link_1', 'threatens'));

    const res = await send('GET', '/project-control-links?toType=decision&toId=dec_link_1');
    const linked = await data<Linked[]>(res);
    expect(linked.map((l) => [l.relation, l.direction, l.target.type, l.target.code])).toEqual([
      ['decided_by', 'incoming', 'change_request', 'CR-6'],
      ['decided_by', 'incoming', 'benefit', 'B-3'],
      ['decided_by', 'incoming', 'deliverable', 'D6'],
      ['decided_by', 'incoming', 'raid_item', 'RSK-1'],
    ]);
    const fromDecision = await data<Linked[]>(await send('GET', '/project-control-links?toType=benefit&toId=ben_link_1'));
    expect(fromDecision.map((l) => [l.relation, l.target.code])).toEqual([['implements', 'D6'], ['threatens', 'RSK-1']]);
  });

  it('keeps the shape of the new relations and answers 404 for a missing object', async () => {
    await seedGovernance().catch(() => undefined);
    const send = manager();
    const refuse = async (body: ReturnType<typeof link>, status: number, message: string) => {
      const res = await send('POST', '/project-control-links', body);
      expect([res.status, (await errorOf(res)).message]).toEqual([status, message]);
    };
    await refuse(link('decision', 'dec_link_1', 'decision', 'dec_link_1', 'decided_by'), 400, 'A link needs two different objects');
    await refuse(link('benefit', 'ben_link_1', 'task', ids.task1, 'implements'), 400, "The 'implements' relation goes from a task or deliverable to a decision, change request or benefit");
    await refuse(link('decision', 'dec_link_1', 'raid_item', ids.risk, 'decided_by'), 400, "The 'decided_by' relation goes from an object to the decision that settled it");
    await refuse(link('raid_item', ids.risk, 'decision', 'dec_link_1', 'affects'), 400, "The 'affects' relation goes from a register item to a task, milestone, deliverable or benefit");
    await refuse(link('task', ids.task2, 'decision', 'dec_nope', 'decided_by'), 404, "Decision with ID 'dec_nope' not found");
    await refuse(link('deliverable', 'del_nope', 'benefit', 'ben_link_1', 'implements'), 404, "Deliverable with ID 'del_nope' not found");
  });
});

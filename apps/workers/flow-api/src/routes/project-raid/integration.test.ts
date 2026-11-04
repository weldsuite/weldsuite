/**
 * DB-backed integration tests for the RAID log (project control, phase 1):
 * /api/project-raid. Runs against the TypeScript worker and, in conformance
 * mode, the Rust backend (rust/conformance/suites.json), so every status code,
 * message and event payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { softDeleteTaskTree } from '@weldsuite/flow-domain/task-tree';
import { projectRaidRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_raid_manager';
const MEMBER = 'user_raid_member';
const VIEWER = 'user_raid_viewer';
const OUTSIDER = 'user_raid_outsider';
const SCOPE_ALL = 'user_raid_scope_all';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'tasks:create'];
const MEMBER_KEYS = ['projects:read', 'projects:create', 'projects:update', 'tasks:create'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-raid', projectRaidRoutes, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
  });
  return (method, path, body) =>
    request(`/api/project-raid${path}`, {
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

type Item = {
  id: string;
  projectId: string;
  kind: string;
  number: number;
  code: string;
  status: string;
  title: string;
  score: number | null;
  band: string | null;
  dueAt: string | null;
  closedAt: string | null;
  createdAt: string;
  probability: number | null;
  impact: number | null;
  residualProbability: number | null;
  residualImpact: number | null;
  residualScore: number | null;
  severity: string | null;
  description: string | null;
  taskProgress: { done: number; total: number };
};

type Detail = Item & {
  assessments: Array<{ probability: number; impact: number; score: number; band: string; note: string | null; assessedBy: string }>;
  links: Array<{ relation: string; direction: string; target: { type: string; id: string; title: string; code: string | null } }>;
};

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);

beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string, managerId = MANAGER) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: managerId, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

const risk = (projectId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'risk',
  projectId,
  title: 'Supplier delivers late',
  probability: 3,
  impact: 4,
  ...extra,
});

async function createItem(projectId: string, body: Record<string, unknown>, who: Send = manager()): Promise<Item> {
  const res = await who('POST', '', { projectId, ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Item>(res);
}

async function getItem(id: string): Promise<Detail> {
  const res = await manager()('GET', `/${id}`);
  expect(res.status).toBe(200);
  return data<Detail>(res);
}

/**
 * The id a create answered, as the create's events carry it. In conformance
 * mode the spy records the TypeScript run (rolled back) and the answer is
 * Rust's, so the two mint different ids: only the prefix is the same.
 */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const DAY = 86_400_000;
const daysBetween = (from: string, to: string | null) => (new Date(to ?? '').getTime() - new Date(from).getTime()) / DAY;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ── Create and numbering ────────────────────────────────────────────────────

describe('POST /', () => {
  it('numbers each kind on its own per project and answers the display code', async () => {
    await seedProject('prj_raid_num');
    await seedProject('prj_raid_num2');

    const first = await createItem('prj_raid_num', risk('prj_raid_num'));
    const second = await createItem('prj_raid_num', risk('prj_raid_num', { title: 'Second risk' }));
    const assumption = await createItem('prj_raid_num', { kind: 'assumption', title: 'Users have SSO' });
    const issue = await createItem('prj_raid_num', { kind: 'issue', title: 'Build is red' });
    const dependency = await createItem('prj_raid_num', { kind: 'dependency', title: 'Design system v2', direction: 'inbound' });
    const otherProject = await createItem('prj_raid_num2', risk('prj_raid_num2'));
    const third = await createItem('prj_raid_num', risk('prj_raid_num', { title: 'Third risk' }));

    expect([first, second, third].map((item) => item.code)).toEqual(['RSK-1', 'RSK-2', 'RSK-3']);
    expect([first, second, third].map((item) => item.number)).toEqual([1, 2, 3]);
    expect([assumption.code, issue.code, dependency.code, otherProject.code]).toEqual(['A-1', 'ISS-1', 'DEP-1', 'RSK-1']);
  });

  it('hands out distinct numbers to simultaneous creates', async () => {
    await seedProject('prj_raid_race');
    const send = manager();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => send('POST', '', risk('prj_raid_race', { title: `Race ${index}` }))),
    );
    expect(results.every((res) => res.status === 201)).toBe(true);
    const numbers = (await Promise.all(results.map((res) => data<Item>(res)))).map((item) => item.number).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it('computes score and band, and defaults the next review from the band', async () => {
    await seedProject('prj_raid_due');
    const critical = await createItem('prj_raid_due', risk('prj_raid_due', { probability: 5, impact: 4 }));
    const high = await createItem('prj_raid_due', risk('prj_raid_due', { probability: 4, impact: 4 }));
    const medium = await createItem('prj_raid_due', risk('prj_raid_due', { probability: 3, impact: 3 }));
    const low = await createItem('prj_raid_due', risk('prj_raid_due', { probability: 1, impact: 2 }));

    expect([critical, high, medium, low].map((item) => [item.score, item.band])).toEqual([
      [20, 'critical'],
      [16, 'high'],
      [9, 'medium'],
      [2, 'low'],
    ]);
    expect([critical, high, medium, low].map((item) => daysBetween(item.createdAt, item.dueAt))).toEqual([7, 14, 30, 90]);
  });

  it("uses the risk's own review interval, or the date given, over the band's", async () => {
    await seedProject('prj_raid_due2');
    const own = await createItem('prj_raid_due2', risk('prj_raid_due2', { reviewIntervalDays: 3 }));
    expect(daysBetween(own.createdAt, own.dueAt)).toBe(3);
    const given = await createItem('prj_raid_due2', risk('prj_raid_due2', { dueAt: '2027-01-15T09:00:00.000Z' }));
    expect(given.dueAt).toBe('2027-01-15T09:00:00.000Z');
  });

  it('starts each kind in its first status and leaves the other kinds columns empty', async () => {
    await seedProject('prj_raid_kinds');
    const assumption = await createItem('prj_raid_kinds', {
      kind: 'assumption',
      title: 'API stays stable',
      confidence: 'high',
      ifWrong: 'Rework the client',
      dueAt: '2026-12-01T00:00:00.000Z',
    });
    const issue = await createItem('prj_raid_kinds', { kind: 'issue', title: 'Prod outage' });
    const dependency = await createItem('prj_raid_kinds', {
      kind: 'dependency',
      title: 'Wait for legal',
      direction: 'outbound',
      partyType: 'team',
      partyName: 'Legal',
    });

    expect(assumption).toMatchObject({ status: 'open', confidence: 'high', ifWrong: 'Rework the client', probability: null, score: null, band: null, closedAt: null });
    expect(issue).toMatchObject({ status: 'open', severity: 'medium', dueAt: null, score: null });
    expect(dependency).toMatchObject({ status: 'open', direction: 'outbound', partyType: 'team', partyName: 'Legal', severity: null });
  });

  it('records the first assessment of a risk, the start of its trend', async () => {
    await seedProject('prj_raid_first');
    const created = await createItem('prj_raid_first', risk('prj_raid_first'));
    const detail = await getItem(created.id);
    expect(detail.assessments).toHaveLength(1);
    expect(detail.assessments[0]).toMatchObject({ probability: 3, impact: 4, score: 12, band: 'high', note: null, assessedBy: MANAGER });
    const assumption = await createItem('prj_raid_first', { kind: 'assumption', title: 'No assessment for assumptions' });
    expect((await getItem(assumption.id)).assessments).toEqual([]);
  });

  it('publishes created with ids and statuses, and closed when it starts closed', async () => {
    await seedProject('prj_raid_events');
    const created = await createItem('prj_raid_events', risk('prj_raid_events', { ownerId: 'user_owner' }));
    expect(events()).toEqual([
      {
        entityType: 'project_raid_item',
        action: 'created',
        entityId: minted(created.id),
        data: {
          id: minted(created.id),
          projectId: 'prj_raid_events',
          kind: 'risk',
          number: 1,
          code: 'RSK-1',
          title: 'Supplier delivers late',
          status: 'identified',
          ownerId: 'user_owner',
          score: 12,
          band: 'high',
        },
      },
    ]);

    published.mockClear();
    const closed = await createItem('prj_raid_events', { kind: 'issue', title: 'Already fixed', status: 'resolved' });
    expect(actions()).toEqual(['project_raid_item.created', 'project_raid_item.closed']);
    expect(closed.closedAt).not.toBeNull();
  });

  it('rejects what does not fit the kind or the scale', async () => {
    await seedProject('prj_raid_bad');
    const send = manager();
    const bad = async (body: Record<string, unknown>) => (await send('POST', '', body)).status;

    expect(await bad(risk('prj_raid_bad', { probability: 6 }))).toBe(400);
    expect(await bad(risk('prj_raid_bad', { probability: 0 }))).toBe(400);
    expect(await bad(risk('prj_raid_bad', { impact: 2.5 }))).toBe(400);
    expect(await bad({ kind: 'risk', projectId: 'prj_raid_bad', title: 'No rating' })).toBe(400);
    expect(await bad(risk('prj_raid_bad', { title: '   ' }))).toBe(400);
    expect(await bad(risk('prj_raid_bad', { status: 'open' }))).toBe(400);
    // Another kind's field, an unknown kind and a field the API does not accept.
    expect(await bad({ kind: 'assumption', projectId: 'prj_raid_bad', title: 'x', strategy: 'avoid' })).toBe(400);
    expect(await bad({ kind: 'issue', projectId: 'prj_raid_bad', title: 'x', probability: 2 })).toBe(400);
    expect(await bad({ kind: 'epic', projectId: 'prj_raid_bad', title: 'x' })).toBe(400);
    expect(await bad(risk('prj_raid_bad', { id: 'raid_hijack' }))).toBe(400);
    expect(await bad({ kind: 'dependency', projectId: 'prj_raid_bad', title: 'x' })).toBe(400);
    expect(await bad({ kind: 'issue', title: 'No project' })).toBe(400);

    const res = await send('POST', '', risk('prj_raid_bad', { residualProbability: 2 }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('residualProbability and residualImpact must be set together');

    const notAnObject = await send('POST', '', 'not an object');
    expect(notAnObject.status).toBe(400);
    expect((await errorOf(notAnObject)).message).toBe('Invalid request body');
  });

  it("checks a dependency's party project", async () => {
    await seedProject('prj_raid_party');
    await seedProject('prj_raid_party_other', 'user_other_manager');
    const send = manager();
    const dependency = (extra: Record<string, unknown>) =>
      send('POST', '', { kind: 'dependency', projectId: 'prj_raid_party', title: 'Needs another team', direction: 'inbound', ...extra });

    const withoutType = await dependency({ partyProjectId: 'prj_raid_party_other' });
    expect(withoutType.status).toBe(400);
    expect((await errorOf(withoutType)).message).toBe("partyProjectId requires partyType 'project'");

    const own = await dependency({ partyType: 'project', partyProjectId: 'prj_raid_party' });
    expect((await errorOf(own)).message).toBe('A dependency cannot be on its own project');

    const missing = await dependency({ partyType: 'project', partyProjectId: 'prj_nowhere' });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Party project not found');

    // A project the caller is not in.
    const notAMember = await dependency({ partyType: 'project', partyProjectId: 'prj_raid_party_other' });
    expect(notAMember.status).toBe(403);
    expect((await errorOf(notAMember)).message).toBe('You are not a member of this project');

    const ok = await as(SCOPE_ALL)('POST', '', {
      kind: 'dependency',
      projectId: 'prj_raid_party',
      title: 'Needs another team',
      direction: 'inbound',
      partyType: 'project',
      partyProjectId: 'prj_raid_party_other',
    });
    expect(ok.status).toBe(201);
    expect(await data<Item & { partyProjectId: string }>(ok)).toMatchObject({ partyProjectId: 'prj_raid_party_other' });
  });

  it('refuses viewers, outsiders and callers without the permission, and answers 404 for a missing project', async () => {
    await seedProject('prj_raid_access');
    const body = risk('prj_raid_access');

    const viewer = await as(VIEWER)('POST', '', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER)('POST', '', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', body)).status).toBe(403);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', '', body)).status).toBe(201);

    const unknown = await as(SCOPE_ALL)('POST', '', risk('prj_raid_nowhere'));
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe("Project with ID 'prj_raid_nowhere' not found");
    expect(events().filter((event) => event.action === 'created')).toHaveLength(1);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET /', () => {
  beforeAll(async () => {
    await seedProject('prj_raid_list');
    await seedProject('prj_raid_list_b');
    const send = manager();
    await createItem('prj_raid_list', risk('prj_raid_list', { title: 'Server outage', probability: 5, impact: 5, ownerId: 'user_a' }), send);
    await createItem('prj_raid_list', risk('prj_raid_list', { title: 'Staff turnover', probability: 2, impact: 2, ownerId: 'user_b' }), send);
    await createItem('prj_raid_list', risk('prj_raid_list', { title: 'Old risk, closed', status: 'closed', probability: 3, impact: 3 }), send);
    await createItem('prj_raid_list', { kind: 'assumption', title: 'Budget holds', ownerId: 'user_a' }, send);
    await createItem('prj_raid_list', { kind: 'issue', title: 'Login is slow', status: 'in_progress' }, send);
    await createItem('prj_raid_list_b', risk('prj_raid_list_b', { title: 'Other project risk' }), send);
  });

  const titles = async (query: string, who: Send = manager()) => {
    const res = await who('GET', `?${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Item[] }).data.map((item) => item.title).sort();
  };

  it('lists one project, filtered by kind, status, owner, band, open and search', async () => {
    expect(await titles('projectId=prj_raid_list&kind=risk')).toEqual(['Old risk, closed', 'Server outage', 'Staff turnover']);
    expect(await titles('projectId=prj_raid_list&kind=assumption')).toEqual(['Budget holds']);
    expect(await titles('projectId=prj_raid_list&status=in_progress')).toEqual(['Login is slow']);
    expect(await titles('projectId=prj_raid_list&ownerId=user_a')).toEqual(['Budget holds', 'Server outage']);
    expect(await titles('projectId=prj_raid_list&band=critical')).toEqual(['Server outage']);
    expect(await titles('projectId=prj_raid_list&band=low')).toEqual(['Staff turnover']);
    expect(await titles('projectId=prj_raid_list&kind=risk&open=true')).toEqual(['Server outage', 'Staff turnover']);
    expect(await titles('projectId=prj_raid_list&open=false')).toEqual(await titles('projectId=prj_raid_list'));
    expect(await titles('projectId=prj_raid_list&search=slow')).toEqual(['Login is slow']);
    expect(await titles('projectId=prj_raid_list&search=SERVER')).toEqual(['Server outage']);
    // % and _ are text, not wildcards.
    expect(await titles('projectId=prj_raid_list&search=%25')).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const send = manager();
    const first = (await (await send('GET', '?projectId=prj_raid_list&limit=2')).json()) as {
      data: Item[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(first.data).toHaveLength(2);
    expect(first.pagination).toMatchObject({ totalCount: 5, hasMore: true });
    const second = (await (await send('GET', `?projectId=prj_raid_list&limit=2&cursor=${first.pagination.cursor}`)).json()) as typeof first;
    const third = (await (await send('GET', `?projectId=prj_raid_list&limit=2&cursor=${second.pagination.cursor}`)).json()) as typeof first;
    expect(third.pagination).toMatchObject({ hasMore: false, cursor: null });
    const ids = [...first.data, ...second.data, ...third.data].map((item) => item.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('without a project, covers the projects the caller is in', async () => {
    const all = await titles('kind=risk');
    expect(all).toContain('Other project risk');
    expect(all).toContain('Server outage');
    expect(await titles('kind=risk', as(OUTSIDER))).toEqual([]);
    expect(await titles('projectId=prj_raid_list&kind=assumption', as(VIEWER))).toEqual(['Budget holds']);
    expect((await titles('kind=risk', as(SCOPE_ALL))).length).toBeGreaterThanOrEqual(5);
  });

  it('refuses a project the caller is not in, and bad filters', async () => {
    const outsider = await as(OUTSIDER)('GET', '?projectId=prj_raid_list');
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await manager()('GET', '?band=scary')).status).toBe(400);
    expect((await manager()('GET', '?kind=epic')).status).toBe(400);
    expect((await manager()('GET', '?open=maybe')).status).toBe(400);
    expect((await as(MANAGER, ['tasks:create'])('GET', '')).status).toBe(403);
  });

  it('answers each item with its code, band and task progress', async () => {
    const res = await manager()('GET', '?projectId=prj_raid_list&kind=risk&band=critical');
    const [item] = ((await res.json()) as { data: Item[] }).data;
    expect(item).toMatchObject({ code: expect.stringMatching(/^RSK-\d+$/), score: 25, band: 'critical', residualScore: null, taskProgress: { done: 0, total: 0 } });
  });
});

describe('GET /matrix', () => {
  it('counts the open risks per cell, current or after mitigation', async () => {
    await seedProject('prj_raid_matrix');
    const send = manager();
    await createItem('prj_raid_matrix', risk('prj_raid_matrix', { probability: 2, impact: 3 }), send);
    await createItem('prj_raid_matrix', risk('prj_raid_matrix', { probability: 2, impact: 3, residualProbability: 1, residualImpact: 2 }), send);
    await createItem('prj_raid_matrix', risk('prj_raid_matrix', { probability: 5, impact: 5, status: 'mitigating' }), send);
    // Closed risks, other kinds and other projects do not count.
    await createItem('prj_raid_matrix', risk('prj_raid_matrix', { probability: 4, impact: 4, status: 'closed' }), send);
    await createItem('prj_raid_matrix', { kind: 'issue', title: 'Not a risk' }, send);

    const current = await data<{ residual: boolean; total: number; cells: Array<{ probability: number; impact: number; count: number }> }>(
      await send('GET', '/matrix?projectId=prj_raid_matrix'),
    );
    expect(current.residual).toBe(false);
    expect(current.total).toBe(3);
    expect(current.cells).toHaveLength(25);
    const cell = (cells: typeof current.cells, probability: number, impact: number) =>
      cells.find((entry) => entry.probability === probability && entry.impact === impact)?.count;
    expect(cell(current.cells, 2, 3)).toBe(2);
    expect(cell(current.cells, 5, 5)).toBe(1);
    expect(cell(current.cells, 4, 4)).toBe(0);
    expect(current.cells[0]).toEqual({ probability: 1, impact: 1, count: 0 });
    expect(current.cells[24]).toEqual({ probability: 5, impact: 5, count: 1 });

    // After mitigation a risk with no residual assessment stays where it is.
    const residual = await data<typeof current>(await send('GET', '/matrix?projectId=prj_raid_matrix&residual=true'));
    expect(residual.residual).toBe(true);
    expect(residual.total).toBe(3);
    expect(cell(residual.cells, 2, 3)).toBe(1);
    expect(cell(residual.cells, 1, 2)).toBe(1);
    expect(cell(residual.cells, 5, 5)).toBe(1);
  });

  it('covers every project the caller is in without a projectId, and refuses outsiders', async () => {
    const all = await data<{ total: number }>(await manager()('GET', '/matrix'));
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect((await data<{ total: number }>(await as(OUTSIDER)('GET', '/matrix'))).total).toBe(0);
    expect((await as(OUTSIDER)('GET', '/matrix?projectId=prj_raid_matrix')).status).toBe(403);
    expect((await manager()('GET', '/matrix?residual=perhaps')).status).toBe(400);
  });
});

describe('GET /:id', () => {
  it('answers the item with its assessments newest first, links and task progress', async () => {
    await seedProject('prj_raid_get');
    const send = manager();
    const created = await createItem('prj_raid_get', risk('prj_raid_get'), send);
    // Assessments are ordered by time; leave a gap so the order is not a tie.
    await tick();
    await send('POST', `/${created.id}/assess`, { probability: 4, impact: 4, note: 'Second look' });
    await tick();
    await send('POST', `/${created.id}/assess`, { probability: 2, impact: 2, note: 'Third look' });

    const detail = await getItem(created.id);
    expect(detail).toMatchObject({ id: created.id, code: 'RSK-1', score: 4, band: 'low' });
    expect(detail.assessments.map((assessment) => assessment.note)).toEqual(['Third look', 'Second look', null]);
    expect(detail.assessments.map((assessment) => assessment.score)).toEqual([4, 16, 12]);
    expect(detail.links).toEqual([]);
    expect(detail.taskProgress).toEqual({ done: 0, total: 0 });
  });

  it('answers 404 for an unknown or deleted item and 403 for a project the caller is not in', async () => {
    await seedProject('prj_raid_get2');
    const created = await createItem('prj_raid_get2', risk('prj_raid_get2'));

    const missing = await manager()('GET', '/raid_missing');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("RAID item with ID 'raid_missing' not found");
    const outsider = await as(OUTSIDER)('GET', `/${created.id}`);
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await as(VIEWER)('GET', `/${created.id}`)).status).toBe(200);

    await manager()('DELETE', `/${created.id}`);
    expect((await manager()('GET', `/${created.id}`)).status).toBe(404);
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('edits the fields of the kind and clears with null', async () => {
    await seedProject('prj_raid_patch');
    const send = manager();
    const created = await createItem('prj_raid_patch', risk('prj_raid_patch', { description: 'Long text', strategy: 'avoid' }), send);

    published.mockClear();
    const res = await send('PATCH', `/${created.id}`, {
      title: 'Renamed',
      description: null,
      strategy: 'mitigate',
      trigger: 'Supplier misses a date',
      costImpact: 1500.5,
      scheduleImpactDays: 10,
      ownerId: 'user_x',
      category: 'Supply',
      status: 'mitigating',
    });
    expect(res.status).toBe(200);
    expect(await data<Item & { strategy: string; costImpact: string }>(res)).toMatchObject({
      title: 'Renamed',
      description: null,
      strategy: 'mitigate',
      costImpact: '1500.50',
      scheduleImpactDays: 10,
      ownerId: 'user_x',
      category: 'Supply',
      status: 'mitigating',
      score: 12,
      code: 'RSK-1',
    });
    expect(actions()).toEqual(['project_raid_item.updated']);
  });

  it('stamps closedAt on closing, publishes closed once, and clears it on reopening', async () => {
    await seedProject('prj_raid_close');
    const send = manager();
    const created = await createItem('prj_raid_close', { kind: 'issue', title: 'Flaky test' }, send);

    published.mockClear();
    const closed = await data<Item>(await send('PATCH', `/${created.id}`, { status: 'resolved' }));
    expect(closed.closedAt).not.toBeNull();
    expect(actions()).toEqual(['project_raid_item.updated', 'project_raid_item.closed']);
    expect(events()[1]?.data).toMatchObject({ status: 'resolved', kind: 'issue', code: 'ISS-1' });

    published.mockClear();
    const stillClosed = await data<Item>(await send('PATCH', `/${created.id}`, { status: 'closed' }));
    expect(stillClosed.closedAt).toBe(closed.closedAt);
    expect(actions()).toEqual(['project_raid_item.updated']);

    const reopened = await data<Item>(await send('PATCH', `/${created.id}`, { status: 'in_progress' }));
    expect(reopened.closedAt).toBeNull();
  });

  it('is a reassessment when probability or impact change: it enters the trend and can escalate', async () => {
    await seedProject('prj_raid_esc');
    const send = manager();
    const created = await createItem('prj_raid_esc', risk('prj_raid_esc', { probability: 3, impact: 4 }), send);

    published.mockClear();
    const raised = await data<Item>(await send('PATCH', `/${created.id}`, { probability: 5 }));
    expect(raised).toMatchObject({ score: 20, band: 'critical' });
    expect(actions()).toEqual(['project_raid_item.updated', 'project_raid_item.escalated']);
    expect(events()[1]?.data).toMatchObject({ code: 'RSK-1', score: 20, band: 'critical', previousScore: 12, previousBand: 'high' });
    expect((await getItem(created.id)).assessments).toHaveLength(2);

    // Already critical: no second escalation. An edit that leaves the ratings alone adds no assessment.
    published.mockClear();
    await send('PATCH', `/${created.id}`, { impact: 5 });
    expect(actions()).toEqual(['project_raid_item.updated']);
    await send('PATCH', `/${created.id}`, { title: 'Just a rename', probability: 5 });
    expect((await getItem(created.id)).assessments).toHaveLength(3);
  });

  it('rejects another kind field, a bad value and a half residual pair', async () => {
    await seedProject('prj_raid_patch2');
    const send = manager();
    const created = await createItem('prj_raid_patch2', risk('prj_raid_patch2'), send);
    const assumption = await createItem('prj_raid_patch2', { kind: 'assumption', title: 'Holds' }, send);

    expect((await send('PATCH', `/${created.id}`, { confidence: 'high' })).status).toBe(400);
    expect((await send('PATCH', `/${assumption.id}`, { probability: 3 })).status).toBe(400);
    expect((await send('PATCH', `/${created.id}`, { status: 'resolved' })).status).toBe(400);
    expect((await send('PATCH', `/${created.id}`, { title: null })).status).toBe(400);
    expect((await send('PATCH', `/${created.id}`, { kind: 'issue' })).status).toBe(400);
    expect((await send('PATCH', `/${created.id}`, { impact: 9 })).status).toBe(400);

    const half = await send('PATCH', `/${created.id}`, { residualProbability: 2 });
    expect(half.status).toBe(400);
    expect((await errorOf(half)).message).toBe('residualProbability and residualImpact must be set together');
    const pair = await data<Item>(await send('PATCH', `/${created.id}`, { residualProbability: 2, residualImpact: 2 }));
    expect(pair).toMatchObject({ residualProbability: 2, residualImpact: 2, residualScore: 4 });
    const cleared = await data<Item>(await send('PATCH', `/${created.id}`, { residualProbability: null, residualImpact: null }));
    expect(cleared).toMatchObject({ residualProbability: null, residualScore: null });
  });

  it('refuses viewers and outsiders, and answers 404 for a missing item', async () => {
    await seedProject('prj_raid_patch3');
    const created = await createItem('prj_raid_patch3', risk('prj_raid_patch3'));

    expect((await as(VIEWER)('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await manager()('PATCH', '/raid_missing', { title: 'x' })).status).toBe(404);
    expect((await as(MEMBER, MEMBER_KEYS)('PATCH', `/${created.id}`, { title: 'By a member' })).status).toBe(200);
    expect((await getItem(created.id)).title).toBe('By a member');
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('soft deletes the item with its links and publishes the events', async () => {
    await seedProject('prj_raid_del');
    const send = manager();
    const created = await createItem('prj_raid_del', risk('prj_raid_del'), send);
    const task = await send('POST', `/${created.id}/tasks`, { title: 'Order a spare' });
    expect(task.status).toBe(201);

    published.mockClear();
    const res = await send('DELETE', `/${created.id}`);
    expect(res.status).toBe(204);
    expect(actions()).toEqual(['project_raid_item.deleted', 'project_control_link.deleted']);
    expect(events()[0]?.data).toEqual({ id: created.id, projectId: 'prj_raid_del', kind: 'risk', code: 'RSK-1' });

    const [row] = await db.select().from(schema.projectRaidItems).where(eq(schema.projectRaidItems.id, created.id));
    expect(row?.deletedAt).not.toBeNull();
    const leftover = await db.select().from(schema.projectControlLinks).where(eq(schema.projectControlLinks.toId, created.id));
    expect(leftover).toEqual([]);
    expect((await send('GET', `/${created.id}`)).status).toBe(404);
    expect((await send('DELETE', `/${created.id}`)).status).toBe(404);
    expect(await titlesOf('prj_raid_del')).toEqual([]);
  });

  it('wants projects:delete, and write access to the project', async () => {
    await seedProject('prj_raid_del2');
    const created = await createItem('prj_raid_del2', risk('prj_raid_del2'));

    expect((await as(MEMBER, MEMBER_KEYS)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(VIEWER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await getItem(created.id)).id).toBe(created.id);
    expect((await as(MEMBER)('DELETE', `/${created.id}`)).status).toBe(204);
  });

  async function titlesOf(projectId: string) {
    const res = await manager()('GET', `?projectId=${projectId}`);
    return ((await res.json()) as { data: Item[] }).data.map((item) => item.title);
  }
});

// ── Assess ──────────────────────────────────────────────────────────────────

describe('POST /:id/assess', () => {
  it('updates the item, appends an assessment and moves the next review, in one go', async () => {
    await seedProject('prj_raid_assess');
    const send = manager();
    const created = await createItem('prj_raid_assess', risk('prj_raid_assess', { probability: 2, impact: 2 }), send);

    published.mockClear();
    const res = await send('POST', `/${created.id}/assess`, { probability: 4, impact: 3, note: 'Supplier slipped twice' });
    expect(res.status).toBe(200);
    const result = await data<{ item: Item; assessment: Detail['assessments'][number] & { itemId: string; assessedAt: string } }>(res);
    expect(result.item).toMatchObject({ probability: 4, impact: 3, score: 12, band: 'high', status: 'identified' });
    expect(result.assessment).toMatchObject({ itemId: created.id, probability: 4, impact: 3, score: 12, band: 'high', note: 'Supplier slipped twice', assessedBy: MANAGER });
    // The next review is the interval of the new band (high: 14 days) after the assessment.
    expect(daysBetween(result.assessment.assessedAt, result.item.dueAt)).toBe(14);
    expect(actions()).toEqual(['project_raid_item.updated']);

    const detail = await getItem(created.id);
    expect(detail.assessments).toHaveLength(2);
    expect(detail.assessments[0]).toMatchObject({ probability: 4, impact: 3 });
  });

  it("uses the risk's own interval, or the date given", async () => {
    await seedProject('prj_raid_assess2');
    const send = manager();
    const own = await createItem('prj_raid_assess2', risk('prj_raid_assess2', { reviewIntervalDays: 5 }), send);
    const ownResult = await data<{ item: Item; assessment: { assessedAt: string } }>(await send('POST', `/${own.id}/assess`, { probability: 5, impact: 5 }));
    expect(daysBetween(ownResult.assessment.assessedAt, ownResult.item.dueAt)).toBe(5);

    const given = await createItem('prj_raid_assess2', risk('prj_raid_assess2'), send);
    const givenResult = await data<{ item: Item }>(await send('POST', `/${given.id}/assess`, { probability: 1, impact: 1, nextReviewAt: '2027-03-01T00:00:00.000Z' }));
    expect(givenResult.item.dueAt).toBe('2027-03-01T00:00:00.000Z');
  });

  it('escalates when the band rises into critical, and only then', async () => {
    await seedProject('prj_raid_assess3');
    const send = manager();
    const created = await createItem('prj_raid_assess3', risk('prj_raid_assess3', { probability: 2, impact: 5 }), send);

    published.mockClear();
    await send('POST', `/${created.id}/assess`, { probability: 4, impact: 5 });
    expect(actions()).toEqual(['project_raid_item.updated', 'project_raid_item.escalated']);
    expect(events()[1]).toMatchObject({
      entityId: created.id,
      data: { score: 20, band: 'critical', previousScore: 10, previousBand: 'high', code: 'RSK-1' },
    });

    published.mockClear();
    await send('POST', `/${created.id}/assess`, { probability: 5, impact: 5 });
    expect(actions()).toEqual(['project_raid_item.updated']);
    await send('POST', `/${created.id}/assess`, { probability: 1, impact: 1 });
    published.mockClear();
    await send('POST', `/${created.id}/assess`, { probability: 5, impact: 4 });
    expect(actions()).toEqual(['project_raid_item.updated', 'project_raid_item.escalated']);
  });

  it('keeps the residual values left out, sets both, or clears them with null', async () => {
    await seedProject('prj_raid_assess4');
    const send = manager();
    const created = await createItem('prj_raid_assess4', risk('prj_raid_assess4', { residualProbability: 2, residualImpact: 3 }), send);

    const kept = await data<{ item: Item }>(await send('POST', `/${created.id}/assess`, { probability: 3, impact: 3 }));
    expect(kept.item).toMatchObject({ residualProbability: 2, residualImpact: 3, residualScore: 6 });
    const set = await data<{ item: Item }>(await send('POST', `/${created.id}/assess`, { probability: 3, impact: 3, residualProbability: 1, residualImpact: 1 }));
    expect(set.item).toMatchObject({ residualProbability: 1, residualImpact: 1, residualScore: 1 });
    const cleared = await data<{ item: Item }>(await send('POST', `/${created.id}/assess`, { probability: 3, impact: 3, residualProbability: null, residualImpact: null }));
    expect(cleared.item).toMatchObject({ residualProbability: null, residualImpact: null });

    const half = await send('POST', `/${created.id}/assess`, { probability: 3, impact: 3, residualProbability: 2 });
    expect(half.status).toBe(400);
    expect((await errorOf(half)).message).toBe('residualProbability and residualImpact must be set together');
  });

  it('only assesses risks, with valid ratings, for writers', async () => {
    await seedProject('prj_raid_assess5');
    const send = manager();
    const created = await createItem('prj_raid_assess5', risk('prj_raid_assess5'), send);
    const issue = await createItem('prj_raid_assess5', { kind: 'issue', title: 'Not a risk' }, send);

    const wrongKind = await send('POST', `/${issue.id}/assess`, { probability: 3, impact: 3 });
    expect(wrongKind.status).toBe(400);
    expect((await errorOf(wrongKind)).message).toBe('Only risks can be assessed');
    expect((await send('POST', `/${created.id}/assess`, { probability: 6, impact: 3 })).status).toBe(400);
    expect((await send('POST', `/${created.id}/assess`, { probability: 3 })).status).toBe(400);
    expect((await send('POST', `/${created.id}/assess`, { probability: 3, impact: 3, status: 'closed' })).status).toBe(400);
    expect((await as(VIEWER)('POST', `/${created.id}/assess`, { probability: 3, impact: 3 })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${created.id}/assess`, { probability: 3, impact: 3 })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', `/${created.id}/assess`, { probability: 3, impact: 3 })).status).toBe(403);
    expect((await send('POST', '/raid_missing/assess', { probability: 3, impact: 3 })).status).toBe(404);
  });
});

// ── Convert ─────────────────────────────────────────────────────────────────

describe('POST /:id/convert', () => {
  it('turns an assumption that proved wrong into a risk, linked back, and marks the source invalid', async () => {
    await seedProject('prj_raid_conv');
    const send = manager();
    const assumption = await createItem('prj_raid_conv', { kind: 'assumption', title: 'The API stays stable', ownerId: 'user_a', category: 'Tech', description: 'Per the vendor' }, send);

    published.mockClear();
    const res = await send('POST', `/${assumption.id}/convert`, { to: 'risk', probability: 4, impact: 4 });
    expect(res.status).toBe(201);
    const result = await data<{ item: Item & { ownerId: string; category: string }; source: Item; link: Record<string, string> }>(res);

    expect(result.item).toMatchObject({ kind: 'risk', code: 'RSK-1', status: 'identified', title: 'The API stays stable', ownerId: 'user_a', category: 'Tech', description: 'Per the vendor', score: 16, band: 'high' });
    expect(daysBetween(result.item.createdAt, result.item.dueAt)).toBe(14);
    expect(result.source).toMatchObject({ id: assumption.id, status: 'invalid' });
    expect(result.source.closedAt).not.toBeNull();
    expect(result.link).toMatchObject({ fromType: 'raid_item', fromId: result.item.id, toType: 'raid_item', toId: assumption.id, relation: 'raised_from', createdBy: MANAGER });

    expect(actions()).toEqual([
      'project_raid_item.created',
      'project_raid_item.converted',
      'project_raid_item.closed',
      'project_control_link.created',
    ]);
    expect(events()[1]).toMatchObject({
      entityId: assumption.id,
      data: { status: 'invalid', to: 'risk', newItemId: minted(result.item.id), newCode: 'RSK-1' },
    });

    // Both stay readable, and the new risk starts its trend.
    const detail = await getItem(result.item.id);
    expect(detail.assessments).toHaveLength(1);
    expect(detail.links).toMatchObject([{ relation: 'raised_from', direction: 'outgoing', target: { id: assumption.id, code: 'A-1', title: 'The API stays stable' } }]);
    const sourceDetail = await getItem(assumption.id);
    expect(sourceDetail.links).toMatchObject([{ relation: 'raised_from', direction: 'incoming', target: { id: result.item.id, code: 'RSK-1' } }]);
  });

  it('turns a risk that happened into an issue, with the severity of its band', async () => {
    await seedProject('prj_raid_conv2');
    const send = manager();
    const created = await createItem('prj_raid_conv2', risk('prj_raid_conv2', { probability: 5, impact: 5 }), send);

    const res = await send('POST', `/${created.id}/convert`, { to: 'issue', title: 'Supplier is late', ownerId: null, dueAt: '2026-12-24T00:00:00.000Z' });
    expect(res.status).toBe(201);
    const result = await data<{ item: Item & { ownerId: string | null }; source: Item }>(res);
    expect(result.item).toMatchObject({ kind: 'issue', code: 'ISS-1', status: 'open', severity: 'critical', title: 'Supplier is late', ownerId: null, dueAt: '2026-12-24T00:00:00.000Z', score: null });
    expect(result.source).toMatchObject({ id: created.id, status: 'occurred' });
    expect(result.source.closedAt).not.toBeNull();

    const explicit = await createItem('prj_raid_conv2', risk('prj_raid_conv2', { probability: 1, impact: 1 }), send);
    const second = await data<{ item: Item }>(await send('POST', `/${explicit.id}/convert`, { to: 'issue', severity: 'high' }));
    expect(second.item).toMatchObject({ code: 'ISS-2', severity: 'high' });
  });

  it('only converts open assumptions and risks, into the right kind, with the right fields', async () => {
    await seedProject('prj_raid_conv3');
    const send = manager();
    const assumption = await createItem('prj_raid_conv3', { kind: 'assumption', title: 'A' }, send);
    const created = await createItem('prj_raid_conv3', risk('prj_raid_conv3'), send);
    const issue = await createItem('prj_raid_conv3', { kind: 'issue', title: 'I' }, send);
    const dependency = await createItem('prj_raid_conv3', { kind: 'dependency', title: 'D', direction: 'inbound' }, send);
    const message = async (res: Response) => (await errorOf(res)).message;

    const wrongTarget = await send('POST', `/${assumption.id}/convert`, { to: 'issue' });
    expect([wrongTarget.status, await message(wrongTarget)]).toEqual([400, 'An assumption can only be converted to a risk']);
    const riskToRisk = await send('POST', `/${created.id}/convert`, { to: 'risk', probability: 1, impact: 1 });
    expect([riskToRisk.status, await message(riskToRisk)]).toEqual([400, 'A risk can only be converted to an issue']);
    for (const source of [issue, dependency]) {
      const res = await send('POST', `/${source.id}/convert`, { to: 'issue' });
      expect([res.status, await message(res)]).toEqual([400, 'Only assumptions and risks can be converted']);
    }
    const noRatings = await send('POST', `/${assumption.id}/convert`, { to: 'risk' });
    expect([noRatings.status, await message(noRatings)]).toEqual([400, 'probability and impact are required to convert to a risk']);
    const severityOnRisk = await send('POST', `/${assumption.id}/convert`, { to: 'risk', probability: 2, impact: 2, severity: 'low' });
    expect([severityOnRisk.status, await message(severityOnRisk)]).toEqual([400, 'severity only applies when converting to an issue']);
    const ratingsOnIssue = await send('POST', `/${created.id}/convert`, { to: 'issue', probability: 2 });
    expect([ratingsOnIssue.status, await message(ratingsOnIssue)]).toEqual([400, 'probability and impact only apply when converting to a risk']);
    expect((await send('POST', `/${created.id}/convert`, { to: 'epic' })).status).toBe(400);

    // Nothing was created or closed by the refused attempts.
    expect(await listCount('prj_raid_conv3')).toBe(4);

    await send('POST', `/${created.id}/convert`, { to: 'issue' });
    const again = await send('POST', `/${created.id}/convert`, { to: 'issue' });
    expect([again.status, await message(again)]).toEqual([409, 'This item is already closed']);
  });

  it('refuses viewers and outsiders, and answers 404 for a missing item', async () => {
    await seedProject('prj_raid_conv4');
    const created = await createItem('prj_raid_conv4', risk('prj_raid_conv4'));

    expect((await as(VIEWER)('POST', `/${created.id}/convert`, { to: 'issue' })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${created.id}/convert`, { to: 'issue' })).status).toBe(403);
    expect((await manager()('POST', '/raid_missing/convert', { to: 'issue' })).status).toBe(404);
    expect((await getItem(created.id)).status).toBe('identified');
  });

  async function listCount(projectId: string) {
    const res = await manager()('GET', `?projectId=${projectId}`);
    return ((await res.json()) as { data: Item[] }).data.length;
  }
});

// ── Mitigation and resolution tasks ─────────────────────────────────────────

describe('POST /:id/tasks', () => {
  it('creates an ordinary task, links it to the risk and counts its progress on read', async () => {
    await seedProject('prj_raid_task');
    const send = manager();
    const created = await createItem('prj_raid_task', risk('prj_raid_task'), send);

    published.mockClear();
    const res = await send('POST', `/${created.id}/tasks`, {
      title: 'Order a spare part',
      description: 'From the second supplier',
      assigneeId: 'user_assignee',
      dueDate: '2026-12-01T00:00:00.000Z',
      priority: 'high',
    });
    expect(res.status).toBe(201);
    const result = await data<{ task: Record<string, unknown>; link: Record<string, string>; taskProgress: { done: number; total: number } }>(res);
    expect(result.task).toMatchObject({
      title: 'Order a spare part',
      status: 'todo',
      priority: 'high',
      assigneeId: 'user_assignee',
      dueDate: '2026-12-01T00:00:00.000Z',
      projectId: 'prj_raid_task',
      number: expect.any(Number),
    });
    expect(result.link).toMatchObject({ fromType: 'task', fromId: result.task.id, toType: 'raid_item', toId: created.id, relation: 'mitigates', createdBy: MANAGER });
    expect(result.taskProgress).toEqual({ done: 0, total: 1 });
    expect(actions()).toEqual(['project_task.created', 'project_control_link.created']);

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, result.task.id as string));
    expect(task).toMatchObject({ title: 'Order a spare part', reporterId: MANAGER, projectId: 'prj_raid_task', type: 'task' });

    const detail = await getItem(created.id);
    expect(detail.taskProgress).toEqual({ done: 0, total: 1 });
    expect(detail.links).toMatchObject([{ relation: 'mitigates', direction: 'incoming', target: { type: 'task', id: result.task.id, title: 'Order a spare part' } }]);

    // Progress follows the tasks: done counts, cancelled leaves the total, a deleted task is gone.
    const second = await data<{ task: { id: string } }>(await send('POST', `/${created.id}/tasks`, { title: 'Call the supplier' }));
    const third = await data<{ task: { id: string } }>(await send('POST', `/${created.id}/tasks`, { title: 'Write it up' }));
    await db.update(schema.tasks).set({ status: 'done' }).where(eq(schema.tasks.id, result.task.id as string));
    expect((await getItem(created.id)).taskProgress).toEqual({ done: 1, total: 3 });
    await db.update(schema.tasks).set({ status: 'cancelled' }).where(eq(schema.tasks.id, second.task.id));
    expect((await getItem(created.id)).taskProgress).toEqual({ done: 1, total: 2 });
    await softDeleteTaskTree(db, third.task.id);
    expect((await getItem(created.id)).taskProgress).toEqual({ done: 1, total: 1 });
    // Deleting a task takes its links with it.
    const remaining = await db.select().from(schema.projectControlLinks).where(eq(schema.projectControlLinks.fromId, third.task.id));
    expect(remaining).toEqual([]);
    const listed = ((await (await send('GET', '?projectId=prj_raid_task')).json()) as { data: Item[] }).data;
    expect(listed.find((item) => item.id === created.id)?.taskProgress).toEqual({ done: 1, total: 1 });
  });

  it('links an issue with resolves and refuses the other kinds', async () => {
    await seedProject('prj_raid_task2');
    const send = manager();
    const issue = await createItem('prj_raid_task2', { kind: 'issue', title: 'Build is red' }, send);
    const assumption = await createItem('prj_raid_task2', { kind: 'assumption', title: 'Holds' }, send);
    const dependency = await createItem('prj_raid_task2', { kind: 'dependency', title: 'D', direction: 'inbound' }, send);

    const res = await send('POST', `/${issue.id}/tasks`, { title: 'Fix the build' });
    expect(res.status).toBe(201);
    expect((await data<{ link: { relation: string } }>(res)).link.relation).toBe('resolves');

    for (const other of [assumption, dependency]) {
      const refused = await send('POST', `/${other.id}/tasks`, { title: 'Nope' });
      expect(refused.status).toBe(400);
      expect((await errorOf(refused)).message).toBe('Only risks and issues can have mitigation or resolution tasks');
    }
    expect(await taskCount('prj_raid_task2')).toBe(1);
  });

  it('validates the body, and wants write access and both permissions', async () => {
    await seedProject('prj_raid_task3');
    const send = manager();
    const created = await createItem('prj_raid_task3', risk('prj_raid_task3'), send);

    expect((await send('POST', `/${created.id}/tasks`, {})).status).toBe(400);
    expect((await send('POST', `/${created.id}/tasks`, { title: '  ' })).status).toBe(400);
    expect((await send('POST', `/${created.id}/tasks`, { title: 'x', projectId: 'prj_other' })).status).toBe(400);
    expect((await send('POST', `/${created.id}/tasks`, { title: 'x', priority: 'urgent' })).status).toBe(400);
    expect((await as(VIEWER)('POST', `/${created.id}/tasks`, { title: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${created.id}/tasks`, { title: 'x' })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read', 'projects:update'])('POST', `/${created.id}/tasks`, { title: 'x' })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read', 'tasks:create'])('POST', `/${created.id}/tasks`, { title: 'x' })).status).toBe(403);
    expect((await send('POST', '/raid_missing/tasks', { title: 'x' })).status).toBe(404);
    expect(await taskCount('prj_raid_task3')).toBe(0);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', `/${created.id}/tasks`, { title: 'By a member' })).status).toBe(201);
  });

  async function taskCount(projectId: string) {
    const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId)));
    return rows.length;
  }
});

// A task made outside the register is untouched by the register.
describe('tasks outside the register', () => {
  it('keep working when linked tasks are deleted', async () => {
    await seedProject('prj_raid_plain');
    const { row } = await createTask(db, { title: 'Plain task' }, { projectId: 'prj_raid_plain', userId: MANAGER });
    expect(await softDeleteTaskTree(db, row.id)).toHaveLength(1);
  });
});

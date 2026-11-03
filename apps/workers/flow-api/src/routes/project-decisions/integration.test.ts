/**
 * DB-backed integration tests for the decision log: /api/project-decisions.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json), so every status code, message and event
 * payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval, listSubjectApprovals } from '@weldsuite/flow-domain/approvals';
import { projectDecisionsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_dec_manager';
const MEMBER = 'user_dec_member';
const VIEWER = 'user_dec_viewer';
const OUTSIDER = 'user_dec_outsider';
const DECIDER = 'user_dec_decider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];
const MEMBER_KEYS = ['projects:read', 'projects:create', 'projects:update'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-decisions', projectDecisionsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-decisions${path}`, {
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

type Option = { title: string; note: string | null; chosen: boolean };

type Decision = {
  id: string;
  projectId: string;
  number: number;
  code: string;
  status: string;
  title: string;
  context: string | null;
  options: Option[];
  consequences: string[];
  deciderId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionDueAt: string | null;
  supersededById: string | null;
};

type Detail = Decision & {
  links: Array<{ relation: string; direction: string; target: { type: string; id: string; code: string | null } }>;
  approvals: Array<{ approverId: string; decision: string; note: string | null; dueAt: string | null }>;
  supersededBy: { id: string; code: string; title: string } | null;
  supersedes: Array<{ id: string; code: string }>;
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

async function seedProject(id: string, settings: Record<string, unknown> | null = null) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, settings, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_d`, projectId: id, userId: DECIDER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

const options = () => [
  { title: 'Switch off at go-live', note: 'Cheapest' },
  { title: 'Keep read-only for 90 days', note: 'EUR 2.400 extra hosting' },
  { title: 'Run both shops' },
];

async function createDecision(projectId: string, body: Record<string, unknown> = {}, who: Send = manager()): Promise<Decision> {
  const res = await who('POST', '', { projectId, title: 'Keep the legacy shop read-only', ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Decision>(res);
}

async function getDecision(id: string, who: Send = manager()): Promise<Detail> {
  const res = await who('GET', `/${id}`);
  expect(res.status).toBe(200);
  return data<Detail>(res);
}

/** The id a create answered, as the create's events carry it (Rust mints its own ids in conformance mode). */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ── Create and numbering ────────────────────────────────────────────────────

describe('POST /', () => {
  it('numbers decisions DEC-n per project, proposed by default, and publishes one event', async () => {
    await seedProject('prj_dec_num');
    await seedProject('prj_dec_num2');

    const first = await createDecision('prj_dec_num', { options: options(), consequences: ['Hosting +EUR 2.400'], context: 'Fallback for RSK-4' });
    const second = await createDecision('prj_dec_num', { title: 'Second' });
    const other = await createDecision('prj_dec_num2');
    const third = await createDecision('prj_dec_num', { title: 'Third' });

    expect([first, second, third].map((d) => d.code)).toEqual(['DEC-1', 'DEC-2', 'DEC-3']);
    expect(other.code).toBe('DEC-1');
    expect(first).toMatchObject({
      status: 'proposed',
      context: 'Fallback for RSK-4',
      consequences: ['Hosting +EUR 2.400'],
      deciderId: null,
      decidedBy: null,
      decidedAt: null,
      supersededById: null,
    });
    expect(first.options).toEqual([
      { title: 'Switch off at go-live', note: 'Cheapest', chosen: false },
      { title: 'Keep read-only for 90 days', note: 'EUR 2.400 extra hosting', chosen: false },
      { title: 'Run both shops', note: null, chosen: false },
    ]);
    expect(actions().slice(0, 1)).toEqual(['project_decision.created']);
    expect(events()[0]).toMatchObject({
      entityId: minted(first.id),
      data: { projectId: 'prj_dec_num', number: 1, code: 'DEC-1', status: 'proposed', deciderId: null },
    });
  });

  it('hands out distinct numbers to simultaneous creates', async () => {
    await seedProject('prj_dec_race');
    const send = manager();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => send('POST', '', { projectId: 'prj_dec_race', title: `Race ${index}` })),
    );
    expect(results.every((res) => res.status === 201)).toBe(true);
    const numbers = (await Promise.all(results.map((res) => data<Decision>(res)))).map((d) => d.number).sort();
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it('records a decision that is already taken: the option chosen, decided by the caller, two events', async () => {
    await seedProject('prj_dec_taken');
    const created = await createDecision('prj_dec_taken', {
      status: 'decided',
      options: [{ title: 'A' }, { title: 'B', chosen: true }],
    });
    expect(created).toMatchObject({ status: 'decided', decidedBy: MANAGER, deciderId: null, decisionDueAt: null });
    expect(created.decidedAt).not.toBeNull();
    expect(created.options.map((o) => o.chosen)).toEqual([false, true]);
    expect(actions()).toEqual(['project_decision.created', 'project_decision.decided']);

    const given = await createDecision('prj_dec_taken', { status: 'decided', decidedBy: 'user_board', decidedAt: '2026-10-28T09:00:00.000Z' });
    expect(given).toMatchObject({ decidedBy: 'user_board', decidedAt: '2026-10-28T09:00:00.000Z' });
  });

  it('asks the named decider: one approval row with the due date, and its event', async () => {
    await seedProject('prj_dec_ask');
    const created = await createDecision('prj_dec_ask', {
      deciderId: DECIDER,
      decisionDueAt: '2026-11-06T00:00:00.000Z',
      options: options(),
    });
    expect(created).toMatchObject({ status: 'proposed', deciderId: DECIDER, decisionDueAt: '2026-11-06T00:00:00.000Z' });
    expect(actions()).toEqual(['project_decision.created', 'flow_approval.requested']);

    const rows = await listSubjectApprovals(db, 'decision', created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'prj_dec_ask',
      approverKind: 'member',
      approverId: DECIDER,
      step: 1,
      decision: 'pending',
      createdBy: MANAGER,
      rule: { code: 'decision', params: { rule: 'named_decider' } },
    });
    expect(rows[0]?.dueAt?.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(events()[1]).toMatchObject({
      entityType: 'flow_approval',
      data: { subjectType: 'decision', subjectId: minted(created.id), approverId: DECIDER, step: 1, decision: 'pending' },
    });
  });

  it('refuses a bad body and the fields of the other status', async () => {
    await seedProject('prj_dec_bad');
    const send = manager();
    const refuse = async (body: Record<string, unknown>, message: string) => {
      const res = await send('POST', '', { projectId: 'prj_dec_bad', title: 'x', ...body });
      expect([res.status, (await errorOf(res)).message]).toEqual([400, message]);
    };
    await refuse({ title: '' }, 'Invalid request body');
    await refuse({ status: 'superseded' }, 'Invalid request body');
    await refuse({ extra: 1 }, 'Invalid request body');
    await refuse({ options: [{ title: 'A', chosen: true }, { title: 'B', chosen: true }] }, 'Only one option can be chosen');
    await refuse({ decidedBy: 'u1' }, 'decidedBy and decidedAt only apply to a decided decision');
    await refuse({ status: 'decided', deciderId: 'u1' }, 'deciderId and decisionDueAt only apply to a proposed decision');
    await refuse({ status: 'decided', options: [{ title: 'A' }] }, 'Choose the option that was taken');
    expect((await send('POST', '', { projectId: 'prj_dec_bad' })).status).toBe(400);
    expect(actions()).toEqual([]);
  });

  it('refuses viewers, outsiders, callers without the permission and a project that does not exist', async () => {
    await seedProject('prj_dec_deny');
    const body = { projectId: 'prj_dec_deny', title: 'x' };
    const viewer = await as(VIEWER)('POST', '', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER)('POST', '', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', body)).status).toBe(403);
    const missing = await manager()('POST', '', { projectId: 'prj_dec_missing', title: 'x' });
    expect(missing.status).toBe(403);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', '', body)).status).toBe(201);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('lists newest first with the project, status and search filters and cursor paging', async () => {
    await seedProject('prj_dec_list');
    await seedProject('prj_dec_list2');
    const a = await createDecision('prj_dec_list', { title: 'Payment API v3', context: 'Provider announced it' });
    const b = await createDecision('prj_dec_list', { title: 'Hosting', status: 'decided' });
    const c = await createDecision('prj_dec_list', { title: 'Passwords' });
    await createDecision('prj_dec_list2', { title: 'Elsewhere' });

    const send = manager();
    const all = await send('GET', '?projectId=prj_dec_list');
    const body = (await all.json()) as { data: Decision[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((d) => d.code)).toEqual(['DEC-3', 'DEC-2', 'DEC-1']);
    expect(body.pagination).toMatchObject({ totalCount: 3, hasMore: false, cursor: null });

    const proposed = await (await send('GET', '?projectId=prj_dec_list&status=proposed')).json();
    expect((proposed as { data: Decision[] }).data.map((d) => d.id)).toEqual([c.id, a.id]);
    const found = await (await send('GET', '?projectId=prj_dec_list&search=provider')).json();
    expect((found as { data: Decision[] }).data.map((d) => d.id)).toEqual([a.id]);

    const page1 = (await (await send('GET', '?projectId=prj_dec_list&limit=2')).json()) as {
      data: Decision[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string };
    };
    expect(page1.data.map((d) => d.id)).toEqual([c.id, b.id]);
    expect(page1.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const page2 = (await (await send('GET', `?projectId=prj_dec_list&limit=2&cursor=${page1.pagination.cursor}`)).json()) as {
      data: Decision[];
      pagination: { hasMore: boolean };
    };
    expect(page2.data.map((d) => d.id)).toEqual([a.id]);
    expect(page2.pagination.hasMore).toBe(false);

    expect((await send('GET', '?status=nonsense')).status).toBe(400);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_dec_list')).status).toBe(403);
    // Without a project: every project the caller is in.
    const mine = (await (await as(MEMBER)('GET', '')).json()) as { data: Decision[] };
    expect(mine.data.length).toBeGreaterThanOrEqual(4);
    expect((await (await as(OUTSIDER)('GET', '')).json() as { data: Decision[] }).data).toEqual([]);
  });
});

describe('GET /:id', () => {
  it('answers the decision with its links, approvals and what it replaced', async () => {
    await seedProject('prj_dec_get');
    const old = await createDecision('prj_dec_get', { title: 'Go live on 8 January', status: 'decided' });
    const next = await createDecision('prj_dec_get', { title: 'Go live on 15 January', status: 'decided' });
    const res = await manager()('POST', `/${old.id}/supersede`, { supersededById: next.id });
    expect(res.status).toBe(200);

    const oldDetail = await getDecision(old.id);
    expect(oldDetail).toMatchObject({ status: 'superseded', supersededById: next.id, supersededBy: { id: next.id, code: 'DEC-2', title: 'Go live on 15 January' }, supersedes: [] });
    const nextDetail = await getDecision(next.id);
    expect(nextDetail.supersedes).toMatchObject([{ id: old.id, code: 'DEC-1' }]);
    expect(nextDetail.supersededBy).toBeNull();

    // A link to a risk, seen from the decision.
    const now = new Date();
    await db.insert(schema.projectRaidItems).values({
      id: 'raid_dec_get',
      projectId: 'prj_dec_get',
      kind: 'risk',
      number: 4,
      title: 'Migration incomplete',
      status: 'identified',
      probability: 4,
      impact: 5,
      createdBy: MANAGER,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectControlLinks).values({
      id: 'pcl_dec_get',
      projectId: 'prj_dec_get',
      fromType: 'raid_item',
      fromId: 'raid_dec_get',
      toType: 'decision',
      toId: next.id,
      relation: 'decided_by',
      createdBy: MANAGER,
    });
    const linked = await getDecision(next.id);
    expect(linked.links).toMatchObject([{ relation: 'decided_by', direction: 'incoming', target: { type: 'raid_item', id: 'raid_dec_get', code: 'RSK-4' } }]);
    const fromRisk = await getDecision(next.id, as(VIEWER));
    expect(fromRisk.id).toBe(next.id);
  });

  it('answers 404 for an unknown or deleted decision and 403 for a project the caller is not in', async () => {
    await seedProject('prj_dec_get2');
    const created = await createDecision('prj_dec_get2');
    const missing = await manager()('GET', '/dec_nope');
    expect([missing.status, (await errorOf(missing)).message]).toEqual([404, 'Decision with ID 'dec_nope' not found']);
    const outsider = await as(OUTSIDER)('GET', `/${created.id}`);
    expect([outsider.status, (await errorOf(outsider)).message]).toEqual([403, 'You are not a member of this project']);
    expect((await as(MANAGER, ['tasks:read'])('GET', `/${created.id}`)).status).toBe(403);
    await manager()('DELETE', `/${created.id}`);
    expect((await manager()('GET', `/${created.id}`)).status).toBe(404);
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('edits a proposed decision, and publishes an updated event', async () => {
    await seedProject('prj_dec_edit');
    const created = await createDecision('prj_dec_edit', { options: options() });
    published.mockClear();
    const res = await as(MEMBER, MEMBER_KEYS)('PATCH', `/${created.id}`, {
      title: 'Read-only for 90 days',
      context: 'New context',
      consequences: ['One', 'Two'],
      options: [{ title: 'Only option', chosen: true }],
    });
    expect(res.status).toBe(200);
    expect(await data<Decision>(res)).toMatchObject({
      title: 'Read-only for 90 days',
      context: 'New context',
      consequences: ['One', 'Two'],
      options: [{ title: 'Only option', note: null, chosen: true }],
      status: 'proposed',
    });
    expect(actions()).toEqual(['project_decision.updated']);
    const cleared = await manager()('PATCH', `/${created.id}`, { context: null });
    expect((await data<Decision>(cleared)).context).toBeNull();
  });

  it('asks again when the decider or the due date changes, and clears the earlier request', async () => {
    await seedProject('prj_dec_reroute');
    const created = await createDecision('prj_dec_reroute', { deciderId: DECIDER, decisionDueAt: '2026-11-06T00:00:00.000Z' });
    published.mockClear();

    // The same decider and date: nothing to ask again.
    expect((await manager()('PATCH', `/${created.id}`, { deciderId: DECIDER, title: 'Same' })).status).toBe(200);
    expect(actions()).toEqual(['project_decision.updated']);
    expect(await listSubjectApprovals(db, 'decision', created.id)).toHaveLength(1);

    published.mockClear();
    const moved = await manager()('PATCH', `/${created.id}`, { deciderId: MEMBER, decisionDueAt: '2026-11-20T00:00:00.000Z' });
    expect(moved.status).toBe(200);
    expect(actions()).toEqual(['project_decision.updated', 'flow_approval.cancelled', 'flow_approval.requested']);
    const rows = await listSubjectApprovals(db, 'decision', created.id);
    expect(rows.map((row) => [row.approverId, row.dueAt?.toISOString()])).toEqual([[MEMBER, '2026-11-20T00:00:00.000Z']]);

    // Clearing the decider withdraws the request.
    published.mockClear();
    expect((await manager()('PATCH', `/${created.id}`, { deciderId: null })).status).toBe(200);
    expect(actions()).toEqual(['project_decision.updated', 'flow_approval.cancelled']);
    expect(await listSubjectApprovals(db, 'decision', created.id)).toHaveLength(0);
  });

  it('asks a declined proposal again after it is edited', async () => {
    await seedProject('prj_dec_declined');
    const created = await createDecision('prj_dec_declined', { deciderId: DECIDER });
    const [row] = await listSubjectApprovals(db, 'decision', created.id);
    const declined = await decideApproval(db, { approvalId: row!.id, actor: DECIDER, decision: 'rejected', note: 'Not now' });
    expect(declined).toMatchObject({ ok: true, outcome: 'rejected' });
    expect((await getDecision(created.id)).status).toBe('proposed');

    published.mockClear();
    expect((await manager()('PATCH', `/${created.id}`, { deciderId: DECIDER })).status).toBe(200);
    expect(actions()).toEqual(['project_decision.updated', 'flow_approval.cancelled', 'flow_approval.requested']);
    const rows = await listSubjectApprovals(db, 'decision', created.id);
    expect(rows.map((r) => r.decision)).toEqual(['pending']);
  });

  it('lets a decided decision change only its title, context and consequences', async () => {
    await seedProject('prj_dec_locked');
    const created = await createDecision('prj_dec_locked', { status: 'decided', options: [{ title: 'A', chosen: true }] });
    const ok = await manager()('PATCH', `/${created.id}`, { title: 'Renamed', consequences: ['Later'] });
    expect(ok.status).toBe(200);
    const locked = await manager()('PATCH', `/${created.id}`, { options: [{ title: 'B' }] });
    expect([locked.status, (await errorOf(locked)).message]).toEqual([409, 'A decided or superseded decision can only change its title, context and consequences']);
    expect((await manager()('PATCH', `/${created.id}`, { deciderId: null })).status).toBe(409);
  });

  it('validates the body and wants write access and the permission', async () => {
    await seedProject('prj_dec_edit2');
    const created = await createDecision('prj_dec_edit2');
    const send = manager();
    expect((await send('PATCH', `/${created.id}`, { title: '' })).status).toBe(400);
    expect((await send('PATCH', `/${created.id}`, { status: 'decided' })).status).toBe(400);
    const twoChosen = await send('PATCH', `/${created.id}`, { options: [{ title: 'A', chosen: true }, { title: 'B', chosen: true }] });
    expect([twoChosen.status, (await errorOf(twoChosen)).message]).toEqual([400, 'Only one option can be chosen']);
    expect((await as(VIEWER)('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);
    expect((await send('PATCH', '/dec_nope', { title: 'x' })).status).toBe(404);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('soft deletes with the links and open approvals, and restores what it replaced', async () => {
    await seedProject('prj_dec_del');
    const old = await createDecision('prj_dec_del', { title: 'Old', status: 'decided' });
    const asked = await createDecision('prj_dec_del', { title: 'Asked', deciderId: DECIDER });
    const replacement = await createDecision('prj_dec_del', { title: 'Replacement', status: 'decided' });
    await manager()('POST', `/${old.id}/supersede`, { supersededById: replacement.id });
    await db.insert(schema.projectControlLinks).values({
      id: 'pcl_dec_del',
      projectId: 'prj_dec_del',
      fromType: 'decision',
      fromId: asked.id,
      toType: 'decision',
      toId: replacement.id,
      relation: 'decided_by',
      createdBy: MANAGER,
    });

    published.mockClear();
    const res = await manager()('DELETE', `/${replacement.id}`);
    expect(res.status).toBe(204);
    expect(actions()).toEqual(['project_decision.deleted', 'project_control_link.deleted', 'project_decision.updated']);
    expect((await manager()('GET', `/${replacement.id}`)).status).toBe(404);
    expect(await getDecision(old.id)).toMatchObject({ status: 'decided', supersededById: null });
    const links = await db.select().from(schema.projectControlLinks).where(eq(schema.projectControlLinks.id, 'pcl_dec_del'));
    expect(links).toHaveLength(0);

    published.mockClear();
    expect((await manager()('DELETE', `/${asked.id}`)).status).toBe(204);
    expect(actions()).toEqual(['project_decision.deleted', 'flow_approval.cancelled']);
    expect(await listSubjectApprovals(db, 'decision', asked.id)).toHaveLength(0);
  });

  it('wants projects:delete and write access', async () => {
    await seedProject('prj_dec_del2');
    const created = await createDecision('prj_dec_del2');
    expect((await as(MEMBER, MEMBER_KEYS)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(VIEWER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await manager()('DELETE', '/dec_nope')).status).toBe(404);
  });
});

// ── Decide ──────────────────────────────────────────────────────────────────

describe('POST /:id/decide', () => {
  it('records the option taken, by the manager, and withdraws the request', async () => {
    await seedProject('prj_dec_decide');
    const created = await createDecision('prj_dec_decide', { options: options(), deciderId: DECIDER });
    published.mockClear();
    const res = await manager()('POST', `/${created.id}/decide`, { chosenIndex: 1, decidedBy: 'user_board', decidedAt: '2026-10-28T09:00:00.000Z' });
    expect(res.status).toBe(200);
    const decided = await data<Decision>(res);
    expect(decided).toMatchObject({ status: 'decided', decidedBy: 'user_board', decidedAt: '2026-10-28T09:00:00.000Z', deciderId: DECIDER });
    expect(decided.options.map((o) => o.chosen)).toEqual([false, true, false]);
    expect(actions()).toEqual(['project_decision.decided', 'flow_approval.cancelled']);
    expect(await listSubjectApprovals(db, 'decision', created.id)).toHaveLength(0);
  });

  it('lets the named decider record it, and defaults who and when', async () => {
    await seedProject('prj_dec_decide2');
    const created = await createDecision('prj_dec_decide2', { options: [{ title: 'A' }, { title: 'B' }], deciderId: DECIDER });
    const res = await as(DECIDER, ['projects:read', 'projects:update'])('POST', `/${created.id}/decide`, { chosenIndex: 0 });
    expect(res.status).toBe(200);
    const decided = await data<Decision>(res);
    expect(decided).toMatchObject({ status: 'decided', decidedBy: DECIDER });
    expect(decided.decidedAt).not.toBeNull();
  });

  it('keeps an option marked chosen on the proposal when none is named', async () => {
    await seedProject('prj_dec_decide3');
    const created = await createDecision('prj_dec_decide3', { options: [{ title: 'A' }, { title: 'B', chosen: true }] });
    const res = await manager()('POST', `/${created.id}/decide`, {});
    expect(res.status).toBe(200);
    expect((await data<Decision>(res)).options.map((o) => o.chosen)).toEqual([false, true]);
    const nothing = await createDecision('prj_dec_decide3', { title: 'No options' });
    expect((await manager()('POST', `/${nothing.id}/decide`, {})).status).toBe(200);
  });

  it('refuses the wrong person, the wrong status and a bad choice', async () => {
    await seedProject('prj_dec_decide4');
    const created = await createDecision('prj_dec_decide4', { options: [{ title: 'A' }, { title: 'B' }], deciderId: DECIDER });
    const message = async (res: Response) => (await errorOf(res)).message;

    const member = await as(MEMBER, MEMBER_KEYS)('POST', `/${created.id}/decide`, { chosenIndex: 0 });
    expect([member.status, await message(member)]).toEqual([403, 'Only the project manager or the named decider can record a decision']);
    const outsider = await as(OUTSIDER)('POST', `/${created.id}/decide`, { chosenIndex: 0 });
    expect([outsider.status, await message(outsider)]).toEqual([403, 'You are not a member of this project']);
    expect((await as(MANAGER, ['projects:read'])('POST', `/${created.id}/decide`, { chosenIndex: 0 })).status).toBe(403);
    expect((await manager()('POST', '/dec_nope/decide', {})).status).toBe(404);

    const noChoice = await manager()('POST', `/${created.id}/decide`, {});
    expect([noChoice.status, await message(noChoice)]).toEqual([400, 'Choose the option that was taken']);
    const noOption = await manager()('POST', `/${created.id}/decide`, { chosenIndex: 5 });
    expect([noOption.status, await message(noOption)]).toEqual([400, 'The chosen option does not exist']);
    expect((await manager()('POST', `/${created.id}/decide`, { chosenIndex: -1 })).status).toBe(400);

    expect((await manager()('POST', `/${created.id}/decide`, { chosenIndex: 0 })).status).toBe(200);
    const again = await manager()('POST', `/${created.id}/decide`, { chosenIndex: 1 });
    expect([again.status, await message(again)]).toEqual([409, 'This decision has already been decided']);
  });
});

// ── Approval of a proposed decision ─────────────────────────────────────────

describe('the named decider approving', () => {
  it('decides the decision on approval, by whoever answered', async () => {
    await seedProject('prj_dec_approve');
    const created = await createDecision('prj_dec_approve', { deciderId: DECIDER, options: [{ title: 'A', chosen: true }] });
    const [row] = await listSubjectApprovals(db, 'decision', created.id);
    const answered = await decideApproval(db, { approvalId: row!.id, actor: DECIDER, decision: 'approved' });
    expect(answered).toMatchObject({ ok: true, outcome: 'approved', resolved: true });

    const detail = await getDecision(created.id);
    expect(detail).toMatchObject({ status: 'decided', decidedBy: DECIDER });
    expect(detail.decidedAt).not.toBeNull();
    expect(detail.approvals).toMatchObject([{ approverId: DECIDER, decision: 'approved' }]);
  });

  it('leaves the decision proposed on a decline, with the note on the approval', async () => {
    await seedProject('prj_dec_decline');
    const created = await createDecision('prj_dec_decline', { deciderId: DECIDER });
    const [row] = await listSubjectApprovals(db, 'decision', created.id);
    await decideApproval(db, { approvalId: row!.id, actor: DECIDER, decision: 'rejected', note: 'Wait for the spike' });
    const detail = await getDecision(created.id);
    expect(detail.status).toBe('proposed');
    expect(detail.decidedBy).toBeNull();
    expect(detail.approvals).toMatchObject([{ approverId: DECIDER, decision: 'rejected', note: 'Wait for the spike' }]);
  });
});

// ── Supersede ───────────────────────────────────────────────────────────────

describe('POST /:id/supersede', () => {
  it('retires a decided decision in favour of another and publishes superseded', async () => {
    await seedProject('prj_dec_sup');
    const old = await createDecision('prj_dec_sup', { title: 'Old', status: 'decided' });
    const next = await createDecision('prj_dec_sup', { title: 'New', status: 'proposed' });
    published.mockClear();
    const res = await manager()('POST', `/${old.id}/supersede`, { supersededById: next.id });
    expect(res.status).toBe(200);
    expect(await data<Decision>(res)).toMatchObject({ id: old.id, status: 'superseded', supersededById: next.id });
    expect(actions()).toEqual(['project_decision.superseded']);
    expect(events()[0]).toMatchObject({ entityId: old.id, data: { status: 'superseded', supersededById: next.id, supersededByCode: 'DEC-2' } });
  });

  it('keeps the rules of who replaces whom', async () => {
    await seedProject('prj_dec_sup2');
    await seedProject('prj_dec_sup3');
    const a = await createDecision('prj_dec_sup2', { title: 'A', status: 'decided' });
    const b = await createDecision('prj_dec_sup2', { title: 'B', status: 'decided' });
    const proposed = await createDecision('prj_dec_sup2', { title: 'P' });
    const elsewhere = await createDecision('prj_dec_sup3', { title: 'E', status: 'decided' });
    const send = manager();
    const message = async (res: Response) => (await errorOf(res)).message;

    const onProposed = await send('POST', `/${proposed.id}/supersede`, { supersededById: a.id });
    expect([onProposed.status, await message(onProposed)]).toEqual([409, 'Only a decided decision can be superseded']);
    const self = await send('POST', `/${a.id}/supersede`, { supersededById: a.id });
    expect([self.status, await message(self)]).toEqual([400, 'A decision cannot replace itself']);
    const cross = await send('POST', `/${a.id}/supersede`, { supersededById: elsewhere.id });
    expect([cross.status, await message(cross)]).toEqual([400, 'The replacing decision must be in the same project']);
    expect((await send('POST', `/${a.id}/supersede`, { supersededById: 'dec_nope' })).status).toBe(404);
    expect((await send('POST', `/${a.id}/supersede`, {})).status).toBe(400);

    expect((await send('POST', `/${a.id}/supersede`, { supersededById: b.id })).status).toBe(200);
    const again = await send('POST', `/${a.id}/supersede`, { supersededById: b.id });
    expect([again.status, await message(again)]).toEqual([409, 'This decision has already been superseded']);
    const bySuperseded = await send('POST', `/${b.id}/supersede`, { supersededById: a.id });
    expect([bySuperseded.status, await message(bySuperseded)]).toEqual([409, 'A superseded decision cannot replace another']);
    const decide = await send('POST', `/${a.id}/decide`, { chosenIndex: 0 });
    expect([decide.status, await message(decide)]).toEqual([409, 'A superseded decision cannot be decided']);
  });

  it('is the project managers', async () => {
    await seedProject('prj_dec_sup4');
    const a = await createDecision('prj_dec_sup4', { title: 'A', status: 'decided' });
    const b = await createDecision('prj_dec_sup4', { title: 'B', status: 'decided' });
    const body = { supersededById: b.id };
    const member = await as(MEMBER, MEMBER_KEYS)('POST', `/${a.id}/supersede`, body);
    expect([member.status, (await errorOf(member)).message]).toEqual([403, 'You do not have manage access to this project']);
    const outsider = await as(OUTSIDER)('POST', `/${a.id}/supersede`, body);
    expect([outsider.status, (await errorOf(outsider)).message]).toEqual([403, 'You are not a member of this project']);
    expect((await as(MANAGER, ['projects:read'])('POST', `/${a.id}/supersede`, body)).status).toBe(403);
    expect((await manager()('POST', '/dec_nope/supersede', body)).status).toBe(404);
  });
});

// ── Slice A writes decided decisions directly ───────────────────────────────

describe('decisions written outside the routes', () => {
  it('keeps numbering and reads a decided row inserted for a change request', async () => {
    await seedProject('prj_dec_direct');
    const first = await createDecision('prj_dec_direct', { title: 'First' });
    expect(first.code).toBe('DEC-1');
    const now = new Date();
    await db.insert(schema.projectDecisions).values({
      id: 'dec_direct_1',
      projectId: 'prj_dec_direct',
      number: 2,
      title: 'Change CR-4 approved',
      status: 'decided',
      decidedBy: MANAGER,
      decidedAt: now,
      createdBy: MANAGER,
      createdAt: now,
      updatedAt: now,
    });
    // The sequence is the routes' (task_number_sequences); a direct writer allocates from the same scope.
    await db
      .update(schema.taskNumberSequences)
      .set({ nextValue: 3 })
      .where(and(eq(schema.taskNumberSequences.scope, 'dec:prj_dec_direct')));
    const next = await createDecision('prj_dec_direct', { title: 'Third' });
    expect(next.code).toBe('DEC-3');
    const direct = await getDecision('dec_direct_1');
    expect(direct).toMatchObject({ code: 'DEC-2', status: 'decided', options: [], consequences: [] });
  });
});

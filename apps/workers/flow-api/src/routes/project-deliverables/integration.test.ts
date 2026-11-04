/**
 * DB-backed integration tests for deliverables: /api/project-deliverables.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval, listSubjectApprovals } from '@weldsuite/flow-domain/approvals';
import { projectDeliverablesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_del_manager';
const MEMBER = 'user_del_member';
const VIEWER = 'user_del_viewer';
const OUTSIDER = 'user_del_outsider';
const SPONSOR = 'user_del_sponsor';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];
const MEMBER_KEYS = ['projects:read', 'projects:create', 'projects:update'];

let db: Database;
type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-deliverables', projectDeliverablesRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-deliverables${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
const manager = () => as(MANAGER);
const data = async <T = Record<string, unknown>>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

type Deliverable = {
  id: string;
  number: number;
  code: string;
  status: string;
  title: string;
  position: number;
  clientVisible: boolean;
  acceptedBy: string | null;
  acceptedAt: string | null;
  acceptanceCriteria: Array<{ text: string; met: boolean; metAt: string | null }>;
  taskProgress: { done: number; total: number };
  criteriaMet: number;
  criteriaTotal: number;
  raid: Array<{ code: string }>;
};

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);
beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string, settings: Record<string, unknown> | null = { sponsorId: SPONSOR }) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, settings, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function create(projectId: string, body: Record<string, unknown> = {}, who: Send = manager()): Promise<Deliverable> {
  const res = await who('POST', '', { projectId, title: 'Account and login', ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Deliverable>(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('POST /', () => {
  it('numbers deliverables D<n> per project, positions them in order and publishes created', async () => {
    await seedProject('prj_del_num');
    await seedProject('prj_del_num2');
    const first = await create('prj_del_num', { acceptanceCriteria: [{ text: 'Login works', met: true }, { text: 'Reset works' }] });
    const second = await create('prj_del_num', { title: 'Second', clientVisible: true });
    const other = await create('prj_del_num2');
    expect([first.code, second.code, other.code]).toEqual(['D1', 'D2', 'D1']);
    expect([first.position, second.position]).toEqual([1, 2]);
    expect(first).toMatchObject({ status: 'not_started', criteriaMet: 1, criteriaTotal: 2, taskProgress: { done: 0, total: 0 }, clientVisible: false });
    expect(first.acceptanceCriteria[0]?.metAt).not.toBeNull();
    expect(first.acceptanceCriteria[1]).toMatchObject({ met: false, metAt: null });
    expect(second.clientVisible).toBe(true);
    expect(actions()).toEqual(Array(3).fill('project_deliverable.created'));
  });

  it('refuses a bad body, an end before the start, viewers and outsiders', async () => {
    await seedProject('prj_del_bad');
    const send = manager();
    const bad = async (body: Record<string, unknown>) => {
      const res = await send('POST', '', { projectId: 'prj_del_bad', title: 'x', ...body });
      return [res.status, (await errorOf(res)).message];
    };
    expect(await bad({ title: '' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ status: 'accepted' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ plannedStart: '2026-12-02T00:00:00Z', plannedEnd: '2026-12-01T00:00:00Z' })).toEqual([400, 'plannedEnd cannot be before plannedStart']);
    expect((await as(VIEWER)('POST', '', { projectId: 'prj_del_bad', title: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', '', { projectId: 'prj_del_bad', title: 'x' })).status).toBe(403);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', '', { projectId: 'prj_del_bad', title: 'x' })).status).toBe(201);
  });
});

describe('GET', () => {
  it('lists in position order with task progress and the register items that affect it', async () => {
    await seedProject('prj_del_list');
    const a = await create('prj_del_list', { title: 'A' });
    const b = await create('prj_del_list', { title: 'B' });
    await manager()('PATCH', `/${a.id}`, { position: 5 });
    const now = new Date();
    await db.insert(schema.tasks).values([
      { id: 'task_del_1', title: 't1', projectId: 'prj_del_list', deliverableId: b.id, status: 'done' },
      { id: 'task_del_2', title: 't2', projectId: 'prj_del_list', deliverableId: b.id, status: 'todo' },
      { id: 'task_del_3', title: 't3', projectId: 'prj_del_list', deliverableId: b.id, status: 'cancelled' },
    ]);
    await db.insert(schema.projectRaidItems).values({
      id: 'raid_del_1', projectId: 'prj_del_list', kind: 'risk', number: 4, title: 'Late', status: 'identified',
      probability: 3, impact: 3, createdBy: MANAGER, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.projectControlLinks).values({
      id: 'pcl_del_1', projectId: 'prj_del_list', fromType: 'raid_item', fromId: 'raid_del_1', toType: 'deliverable', toId: b.id, relation: 'affects', createdBy: MANAGER,
    });
    const res = await manager()('GET', '?projectId=prj_del_list');
    const body = (await res.json()) as { data: Deliverable[]; pagination: { totalCount: number } };
    expect(body.data.map((d) => d.code)).toEqual(['D2', 'D1']);
    expect(body.data[0]).toMatchObject({ taskProgress: { done: 1, total: 2 }, raid: [{ code: 'RSK-4' }] });
    expect(body.pagination.totalCount).toBe(2);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_del_list')).status).toBe(403);
    const detail = await data<Deliverable & { links: Array<{ relation: string; direction: string }>; signoff: unknown[] }>(await manager()('GET', `/${b.id}`));
    expect(detail.links).toMatchObject([{ relation: 'affects', direction: 'incoming' }]);
    expect(detail.signoff).toEqual([]);
    expect((await manager()('GET', '/del_nope')).status).toBe(404);
  });
});

describe('PATCH and DELETE', () => {
  it('edits criteria keeping metAt, and releases tasks and links on delete', async () => {
    await seedProject('prj_del_edit');
    const created = await create('prj_del_edit', { acceptanceCriteria: [{ text: 'a', met: true }] });
    const res = await manager()('PATCH', `/${created.id}`, { acceptanceCriteria: [{ text: 'a', met: true }, { text: 'b' }], status: 'in_progress', ownerId: 'u1' });
    const edited = await data<Deliverable>(res);
    expect(edited.acceptanceCriteria[0]?.metAt).toBe(created.acceptanceCriteria[0]?.metAt);
    expect(edited.status).toBe('in_progress');
    expect((await as(VIEWER)('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(403);

    await db.insert(schema.tasks).values({ id: 'task_del_e1', title: 't', projectId: 'prj_del_edit', deliverableId: created.id });
    published.mockClear();
    expect((await as(MEMBER, MEMBER_KEYS)('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await manager()('DELETE', `/${created.id}`)).status).toBe(204);
    expect(actions()).toEqual(['project_deliverable.deleted']);
    expect((await manager()('GET', `/${created.id}`)).status).toBe(404);
  });
});

describe('accepting', () => {
  it('accepts directly once the criteria are met, and then locks the deliverable', async () => {
    await seedProject('prj_del_acc');
    const created = await create('prj_del_acc', { acceptanceCriteria: [{ text: 'a' }] });
    const refused = await manager()('POST', `/${created.id}/accept`);
    expect([refused.status, (await errorOf(refused)).message]).toEqual([409, 'Every acceptance criterion has to be met first']);
    await manager()('PATCH', `/${created.id}`, { acceptanceCriteria: [{ text: 'a', met: true }] });
    expect((await as(MEMBER, MEMBER_KEYS)('POST', `/${created.id}/accept`)).status).toBe(403);
    published.mockClear();
    const res = await manager()('POST', `/${created.id}/accept`);
    expect(res.status).toBe(200);
    expect(await data<Deliverable>(res)).toMatchObject({ status: 'accepted', acceptedBy: MANAGER });
    expect(actions()).toEqual(['project_deliverable.accepted']);
    const again = await manager()('POST', `/${created.id}/accept`);
    expect([again.status, (await errorOf(again)).message]).toEqual([409, 'This deliverable has already been accepted']);
    expect((await manager()('PATCH', `/${created.id}`, { title: 'x' })).status).toBe(409);
    expect((await manager()('PATCH', `/${created.id}`, { position: 9, clientVisible: true })).status).toBe(200);
    const reject = await manager()('POST', `/${created.id}/reject`, {});
    expect([reject.status, (await errorOf(reject)).message]).toEqual([409, 'An accepted deliverable cannot be rejected']);
  });

  it('rejects, and the rejected deliverable can go back to in progress', async () => {
    await seedProject('prj_del_rej');
    const created = await create('prj_del_rej');
    const res = await manager()('POST', `/${created.id}/reject`, { note: 'Missing invoices' });
    expect(res.status).toBe(200);
    expect((await data<Deliverable>(res)).status).toBe('rejected');
    expect((await manager()('PATCH', `/${created.id}`, { status: 'in_progress' })).status).toBe(200);
  });
});

describe('request-signoff', () => {
  it('asks the sponsor and then the client, and accepts on full approval', async () => {
    await seedProject('prj_del_sign');
    const created = await create('prj_del_sign');
    published.mockClear();
    const res = await manager()('POST', `/${created.id}/request-signoff`, { contactId: 'con_client', dueAt: '2026-12-01T00:00:00.000Z' });
    expect(res.status).toBe(201);
    const result = await data<{ signoff: Array<{ approverKind: string; approverId: string; step: number }> }>(res);
    expect(result.signoff.map((s) => [s.approverKind, s.approverId, s.step])).toEqual([['member', SPONSOR, 1], ['contact', 'con_client', 2]]);
    expect(actions()).toEqual(['flow_approval.requested', 'flow_approval.requested']);

    const again = await manager()('POST', `/${created.id}/request-signoff`, {});
    expect([again.status, (await errorOf(again)).message]).toEqual([409, 'A sign-off is already waiting for an answer']);

    const [sponsorRow, clientRow] = await listSubjectApprovals(db, 'deliverable', created.id);
    const early = await decideApproval(db, { approvalId: clientRow!.id, actor: { kind: 'contact', id: 'con_client' }, decision: 'approved' });
    expect(early).toMatchObject({ ok: false, code: 'step_not_active' });
    await decideApproval(db, { approvalId: sponsorRow!.id, actor: SPONSOR, decision: 'approved' });
    const done = await decideApproval(db, { approvalId: clientRow!.id, actor: { kind: 'contact', id: 'con_client' }, decision: 'approved' });
    expect(done).toMatchObject({ ok: true, resolved: true, outcome: 'approved' });
    const detail = await data<Deliverable & { signoff: Array<{ decision: string }> }>(await manager()('GET', `/${created.id}`));
    expect(detail).toMatchObject({ status: 'accepted', acceptedBy: 'con_client' });
    expect(detail.signoff.map((s) => s.decision)).toEqual(['approved', 'approved']);
  });

  it('rejects on a decline and can be asked again; needs criteria met and a sponsor', async () => {
    await seedProject('prj_del_sign2');
    const created = await create('prj_del_sign2');
    expect((await manager()('POST', `/${created.id}/request-signoff`, {})).status).toBe(201);
    const [row] = await listSubjectApprovals(db, 'deliverable', created.id);
    await decideApproval(db, { approvalId: row!.id, actor: SPONSOR, decision: 'rejected', note: 'No' });
    expect((await data<Deliverable>(await manager()('GET', `/${created.id}`))).status).toBe('rejected');
    published.mockClear();
    expect((await manager()('POST', `/${created.id}/request-signoff`, {})).status).toBe(201);
    expect(actions()).toEqual(['flow_approval.cancelled', 'flow_approval.requested']);

    const open = await create('prj_del_sign2', { acceptanceCriteria: [{ text: 'a' }] });
    const blocked = await manager()('POST', `/${open.id}/request-signoff`, {});
    expect([blocked.status, (await errorOf(blocked)).message]).toEqual([409, 'Every acceptance criterion has to be met first']);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', `/${created.id}/request-signoff`, {})).status).toBe(403);
    expect((await as(OUTSIDER)('POST', `/${created.id}/request-signoff`, {})).status).toBe(403);
  });
});

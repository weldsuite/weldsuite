/**
 * DB-backed integration tests for the stakeholder register, the RACI, the
 * communication plan and the portal access: /api/project-stakeholders. Runs
 * against the TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json). The invitation mail is mocked.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectStakeholdersRoutes } from './index';
import { sendPortalInvitation } from '../../lib/report-notifications';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

vi.mock('../../lib/report-notifications', () => ({
  sendPublishedReport: vi.fn(async () => ({ sent: 0, skipped: 0 })),
  notifyDraftReady: vi.fn(async () => true),
  sendPortalInvitation: vi.fn(async () => true),
}));

const MANAGER = 'user_stk_manager';
const MEMBER = 'user_stk_member';
const VIEWER = 'user_stk_viewer';
const OUTSIDER = 'user_stk_outsider';
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-stakeholders', projectStakeholdersRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-stakeholders${path}`, {
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

type Stakeholder = {
  id: string;
  kind: string;
  name: string | null;
  email: string | null;
  influence: number;
  interest: number;
  portalAccess: boolean;
  portalInvitedAt: string | null;
};

const published = vi.mocked(publishEntityEvent);
const events = () => published.mock.calls.map(([event]) => ({ entityType: event.entityType, action: event.action, entityId: event.entityId, data: event.data as Record<string, unknown> }));
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeEach(() => {
  published.mockClear();
  vi.mocked(sendPortalInvitation).mockClear();
});

async function seedProject(id: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: `Project ${id}`, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function add(projectId: string, body: Record<string, unknown>, who: Send = manager()): Promise<Stakeholder> {
  const res = await who('POST', '', { projectId, ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Stakeholder>(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_stk_1', userId: MANAGER, name: 'Sanne Jansen', email: 'sanne@example.com', role: 'MEMBER' },
    { id: 'wm_stk_2', userId: MEMBER, name: 'Daan Bakker', email: 'daan@example.com', role: 'MEMBER' },
  ]);
  await db.insert(schema.people).values([
    { id: 'per_stk_1', displayName: 'Femke de Graaf', email: 'femke@example.com' },
    { id: 'per_stk_2', displayName: 'Joost Hermans', email: null },
  ]);
}, 60_000);

describe('POST / and the register reads', () => {
  it('adds a member and a contact, with the names behind them and the defaults', async () => {
    await seedProject('prj_sk_add');
    const member = await add('prj_sk_add', { memberId: MEMBER, role: 'Developer' });
    expect(member).toMatchObject({ kind: 'member', name: 'Daan Bakker', email: 'daan@example.com', influence: 3, interest: 3, portalAccess: false, portalInvitedAt: null });
    const contact = await add('prj_sk_add', { crmContactId: 'per_stk_1', organisation: 'Van Dijk', influence: 5, interest: 4, attitude: 'supportive', engagement: 'leading' });
    expect(contact).toMatchObject({ kind: 'contact', name: 'Femke de Graaf', influence: 5, attitude: 'supportive' });
    expect(actions()).toEqual(['project_stakeholder.created', 'project_stakeholder.created']);
    expect(events()[0]?.data).toMatchObject({ id: minted(member.id), kind: 'member', memberId: MEMBER });
    expect(events()[0]?.data).not.toHaveProperty('name');

    const list = (await (await manager()('GET', '?projectId=prj_sk_add')).json()) as { data: Stakeholder[]; pagination: { totalCount: number } };
    expect(list.data.map((row) => row.name)).toEqual(['Daan Bakker', 'Femke de Graaf']);
    expect(list.pagination.totalCount).toBe(2);
    expect((await data<Stakeholder>(await manager()('GET', `/${member.id}`))).id).toBe(member.id);
  });

  it('refuses both or neither identity, unknown people and a second entry for a person', async () => {
    await seedProject('prj_sk_rules');
    const post = (body: Record<string, unknown>) => manager()('POST', '', { projectId: 'prj_sk_rules', ...body });
    const neither = await post({});
    expect(neither.status).toBe(400);
    expect((await errorOf(neither)).message).toBe('Provide either memberId or crmContactId');
    expect((await errorOf(await post({ memberId: MEMBER, crmContactId: 'per_stk_1' }))).message).toBe('Provide either memberId or crmContactId, not both');
    expect((await errorOf(await post({ memberId: 'user_nobody' }))).message).toBe('Member not found');
    expect((await errorOf(await post({ crmContactId: 'per_nobody' }))).message).toBe('Contact not found');
    expect((await post({ memberId: MEMBER, influence: 6 })).status).toBe(400);
    expect((await post({ memberId: MEMBER, attitude: 'angry' })).status).toBe(400);
    expect((await post({ memberId: MEMBER, extra: 1 })).status).toBe(400);
    expect((await post({ memberId: MEMBER })).status).toBe(201);
    const again = await post({ memberId: MEMBER });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This person is already a stakeholder of the project');
  });

  it('checks access: write access to add, membership to read', async () => {
    await seedProject('prj_sk_access');
    expect((await as(VIEWER)('POST', '', { projectId: 'prj_sk_access', memberId: MEMBER })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', '', { projectId: 'prj_sk_access', memberId: MEMBER })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', { projectId: 'prj_sk_access', memberId: MEMBER })).status).toBe(403);
    expect((await as(MEMBER)('POST', '', { projectId: 'prj_sk_access', memberId: MEMBER })).status).toBe(201);
    expect((await as(VIEWER)('GET', '?projectId=prj_sk_access')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_sk_access')).status).toBe(403);
    expect((await manager()('GET', '')).status).toBe(400);
    expect((await manager()('GET', '/stk_nope')).status).toBe(404);
  });
});

describe('PATCH and DELETE /:id', () => {
  it('edits the scores and notes, and removes a stakeholder with their RACI cells and portal access', async () => {
    await seedProject('prj_sk_edit');
    const row = await add('prj_sk_edit', { crmContactId: 'per_stk_1' });
    const res = await manager()('PATCH', `/${row.id}`, { influence: 2, role: '  IT manager  ', notes: 'Prefers email', lastContactAt: '2026-11-03T10:00:00Z' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ influence: 2, role: 'IT manager', notes: 'Prefers email', lastContactAt: '2026-11-03T10:00:00.000Z' });
    expect((await manager()('PATCH', `/${row.id}`, { memberId: MEMBER })).status).toBe(400);
    expect((await as(VIEWER)('PATCH', `/${row.id}`, { influence: 1 })).status).toBe(403);
    expect((await manager()('PATCH', '/stk_nope', { influence: 1 })).status).toBe(404);

    await db.insert(schema.projectRaci).values({ id: 'rac_stk_1', projectId: 'prj_sk_edit', subjectType: 'go_live', stakeholderId: row.id, letter: 'C', createdBy: MANAGER });
    published.mockClear();
    expect((await manager()('DELETE', `/${row.id}`)).status).toBe(204);
    expect(actions()).toEqual(['project_stakeholder.deleted']);
    expect((await manager()('GET', `/${row.id}`)).status).toBe(404);
    expect(await db.select().from(schema.projectRaci).where(eq(schema.projectRaci.stakeholderId, row.id))).toHaveLength(0);
    // The person can be added again.
    expect((await manager()('POST', '', { projectId: 'prj_sk_edit', crmContactId: 'per_stk_1' })).status).toBe(201);
  });
});

describe('RACI', () => {
  it('lists a row per deliverable plus change requests and go-live, and replaces one subject at a time', async () => {
    await seedProject('prj_sk_raci');
    await db.insert(schema.projectDeliverables).values([
      { id: 'del_stk_2', projectId: 'prj_sk_raci', number: 2, title: 'Catalogue', position: 1, createdBy: MANAGER },
      { id: 'del_stk_1', projectId: 'prj_sk_raci', number: 1, title: 'Login', position: 0, createdBy: MANAGER },
    ]);
    const a = await add('prj_sk_raci', { memberId: MANAGER });
    const b = await add('prj_sk_raci', { memberId: MEMBER });
    const c = await add('prj_sk_raci', { crmContactId: 'per_stk_1' });
    published.mockClear();

    const before = await data<{ subjects: Array<{ subjectType: string; subjectId: string | null; code: string | null; assignments: unknown[] }> }>(await manager()('GET', '/raci/prj_sk_raci'));
    expect(before.subjects.map((s) => [s.subjectType, s.code])).toEqual([['deliverable', 'D1'], ['deliverable', 'D2'], ['change_requests', null], ['go_live', null]]);

    const put = await manager()('PUT', '/raci/prj_sk_raci', {
      subjectType: 'deliverable',
      subjectId: 'del_stk_1',
      assignments: [{ stakeholderId: c.id, letter: 'I' }, { stakeholderId: b.id, letter: 'R' }, { stakeholderId: a.id, letter: 'A' }, { stakeholderId: a.id, letter: 'R' }],
    });
    expect(put.status).toBe(200);
    // Ordered by the register, then A R C I.
    expect(await data(put)).toEqual({
      subjectType: 'deliverable',
      subjectId: 'del_stk_1',
      code: 'D1',
      title: 'Login',
      assignments: [
        { stakeholderId: a.id, letter: 'A' },
        { stakeholderId: a.id, letter: 'R' },
        { stakeholderId: b.id, letter: 'R' },
        { stakeholderId: c.id, letter: 'I' },
      ],
    });
    expect(actions()).toEqual(['project_stakeholder.updated', 'project_stakeholder.updated', 'project_stakeholder.updated']);
    expect(events().find((e) => e.entityId === minted(a.id))?.data).toMatchObject({ raci: { subjectType: 'deliverable', subjectId: 'del_stk_1', letters: ['A', 'R'] } });

    // A full replace: the next call drops what it leaves out, and a type-wide row has no subject id.
    published.mockClear();
    const next = await manager()('PUT', '/raci/prj_sk_raci', { subjectType: 'deliverable', subjectId: 'del_stk_1', assignments: [{ stakeholderId: a.id, letter: 'A' }] });
    expect((await data<{ assignments: unknown[] }>(next)).assignments).toHaveLength(1);
    expect(events().map((e) => e.entityId).sort()).toEqual([a.id, b.id, c.id].map(minted).sort());
    const goLive = await manager()('PUT', '/raci/prj_sk_raci', { subjectType: 'go_live', assignments: [{ stakeholderId: b.id, letter: 'A' }] });
    expect(goLive.status).toBe(200);
    const after = await data<{ subjects: Array<{ subjectType: string; assignments: unknown[] }> }>(await manager()('GET', '/raci/prj_sk_raci'));
    expect(after.subjects.map((s) => s.assignments.length)).toEqual([1, 0, 0, 1]);
  });

  it('refuses a bad subject, a second A, a duplicate letter and people outside the project', async () => {
    await seedProject('prj_sk_raci2');
    await seedProject('prj_sk_raci3');
    const a = await add('prj_sk_raci2', { memberId: MANAGER });
    const b = await add('prj_sk_raci2', { memberId: MEMBER });
    const stranger = await add('prj_sk_raci3', { memberId: MANAGER });
    const put = (body: Record<string, unknown>) => manager()('PUT', '/raci/prj_sk_raci2', body);
    const msg = async (body: Record<string, unknown>) => {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return (await errorOf(res)).message;
    };
    expect(await msg({ subjectType: 'deliverable', assignments: [] })).toBe('subjectId is required for a deliverable');
    expect(await msg({ subjectType: 'go_live', subjectId: 'del_x', assignments: [] })).toBe('subjectId is only for a deliverable');
    expect(await msg({ subjectType: 'go_live', assignments: [{ stakeholderId: a.id, letter: 'A' }, { stakeholderId: b.id, letter: 'A' }] })).toBe('A subject can have only one accountable (A)');
    expect(await msg({ subjectType: 'go_live', assignments: [{ stakeholderId: a.id, letter: 'C' }, { stakeholderId: a.id, letter: 'C' }] })).toBe('A stakeholder can have a letter only once per subject');
    expect(await msg({ subjectType: 'deliverable', subjectId: 'del_nope', assignments: [] })).toBe('Deliverable not found');
    expect(await msg({ subjectType: 'go_live', assignments: [{ stakeholderId: stranger.id, letter: 'R' }] })).toBe('Stakeholder not found in this project');
    expect((await put({ subjectType: 'go_live', assignments: [{ stakeholderId: a.id, letter: 'X' }] })).status).toBe(400);
    expect((await put({ assignments: [] })).status).toBe(400);
    expect((await as(VIEWER)('PUT', '/raci/prj_sk_raci2', { subjectType: 'go_live', assignments: [] })).status).toBe(403);
    expect((await as(OUTSIDER)('GET', '/raci/prj_sk_raci2')).status).toBe(403);
    expect((await manager()('PUT', '/raci/prj_sk_missing', { subjectType: 'go_live', assignments: [] })).status).toBe(404);
  });
});

describe('communication plan', () => {
  it('reads an empty plan, replaces it by merge and keeps the other settings', async () => {
    await seedProject('prj_sk_plan');
    await db.update(schema.projects).set({ settings: { sponsorId: 'user_s' } }).where(eq(schema.projects.id, 'prj_sk_plan'));
    expect(await data(await manager()('GET', '/settings/prj_sk_plan'))).toEqual({ projectId: 'prj_sk_plan', communicationPlan: [] });
    const plan = [{ what: 'Weekly status report', audience: 'Sponsor', cadence: 'Mondays', channel: 'Email' }];
    published.mockClear();
    const res = await manager()('PUT', '/settings/prj_sk_plan', { communicationPlan: [{ ...plan[0], what: '  Weekly status report  ' }] });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ projectId: 'prj_sk_plan', communicationPlan: plan });
    const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_sk_plan'));
    expect(row?.settings).toEqual({ sponsorId: 'user_s', communicationPlan: plan });
    expect(actions()).toEqual(['project.updated']);
    expect((await manager()('PUT', '/settings/prj_sk_plan', { communicationPlan: [{ what: '', audience: 'x', cadence: 'x', channel: 'x' }] })).status).toBe(400);
    expect((await as(MEMBER)('PUT', '/settings/prj_sk_plan', { communicationPlan: [] })).status).toBe(403);
    expect((await as(OUTSIDER)('GET', '/settings/prj_sk_plan')).status).toBe(403);
    expect((await manager()('PUT', '/settings/prj_sk_missing', { communicationPlan: [] })).status).toBe(404);
  });
});

describe('portal access', () => {
  it('invites a contact: sets the access and the time, sends the mail, and can take it away', async () => {
    await seedProject('prj_sk_portal');
    const contact = await add('prj_sk_portal', { crmContactId: 'per_stk_1' });
    published.mockClear();
    const res = await manager()('POST', `/${contact.id}/portal-invite`);
    expect(res.status).toBe(200);
    const invited = await data<Stakeholder>(res);
    expect(invited.portalAccess).toBe(true);
    expect(invited.portalInvitedAt).toEqual(expect.any(String));
    expect(actions()).toEqual(['project_stakeholder.updated']);
    expect(vi.mocked(sendPortalInvitation)).toHaveBeenCalledTimes(1);

    published.mockClear();
    const revoked = await manager()('DELETE', `/${contact.id}/portal-access`);
    expect(revoked.status).toBe(200);
    expect((await data<Stakeholder>(revoked)).portalAccess).toBe(false);
    expect(actions()).toEqual(['project_stakeholder.updated']);
  });

  it('refuses a member, a contact without an address, and anyone but a project manager', async () => {
    await seedProject('prj_sk_portal2');
    const member = await add('prj_sk_portal2', { memberId: MEMBER });
    const noMail = await add('prj_sk_portal2', { crmContactId: 'per_stk_2' });
    const member400 = await manager()('POST', `/${member.id}/portal-invite`);
    expect(member400.status).toBe(400);
    expect((await errorOf(member400)).message).toBe('Only a CRM contact can be given portal access');
    const mail400 = await manager()('POST', `/${noMail.id}/portal-invite`);
    expect(mail400.status).toBe(400);
    expect((await errorOf(mail400)).message).toBe('The contact has no email address');
    expect((await as(MEMBER)('POST', `/${noMail.id}/portal-invite`)).status).toBe(403);
    expect((await as(MEMBER)('DELETE', `/${noMail.id}/portal-access`)).status).toBe(403);
    expect((await manager()('POST', '/stk_nope/portal-invite')).status).toBe(404);
    expect((await manager()('DELETE', '/stk_nope/portal-access')).status).toBe(404);
    expect(vi.mocked(sendPortalInvitation)).not.toHaveBeenCalled();
  });
});

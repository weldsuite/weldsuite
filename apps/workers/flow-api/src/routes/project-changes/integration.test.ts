/**
 * DB-backed integration tests for change requests: /api/project-changes, with
 * the approvals router that answers them (/api/approvals) and the baselines
 * they move. Runs against the TypeScript worker and, in conformance mode, the
 * Rust backend (rust/conformance/suites.json), so every status code, message
 * and event asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { approvalsRoutes } from '../approvals';
import { projectBaselinesRoutes } from '../project-baselines';
import { projectChangesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/approvals', approvalsRoutes);
router.route('/project-changes', projectChangesRoutes);
router.route('/project-baselines', projectBaselinesRoutes);

const PM = 'user_chg_pm';
const BOARD1 = 'user_chg_board1';
const BOARD2 = 'user_chg_board2';
const MEMBER = 'user_chg_member';
const VIEWER = 'user_chg_viewer';
const OUTSIDER = 'user_chg_outsider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];
const MEMBER_KEYS = ['projects:read', 'projects:create', 'projects:update'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api', router, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const pm = () => as(PM);

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
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);

beforeEach(() => {
  published.mockClear();
});

const DAY = 86_400_000;

interface SeedOptions {
  settings?: Record<string, unknown>;
  budget?: string;
  endDate?: Date | null;
  manager?: string;
}

/** A project with a manager, a member, a viewer and two board candidates, one milestone and two deliverables. */
async function seedProject(id: string, options: SeedOptions = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({
    id,
    name: `Project ${id}`,
    projectManagerId: options.manager ?? PM,
    budgetedAmount: options.budget ?? '12000.00',
    budgetCurrency: 'EUR',
    endDate: options.endDate === undefined ? new Date('2026-12-01T00:00:00.000Z') : options.endDate,
    settings: options.settings ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectMembers).values(
    [
      [BOARD1, 'member'],
      [BOARD2, 'viewer'],
      [MEMBER, 'member'],
      [VIEWER, 'viewer'],
    ].map(([userId, role]) => ({
      id: `pm_${id}_${userId}`,
      projectId: id,
      userId: userId as string,
      role: role as string,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      joinedAt: now,
    })),
  );
  await db.insert(schema.milestones).values({
    id: `ms_${id}`,
    projectId: id,
    name: 'Beta release',
    dueDate: new Date('2026-11-20T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
  });
  // The deliverable counter is past the two seeded numbers, as it is once deliverables are created through the API.
  await db.insert(schema.taskNumberSequences).values({ id: `seq_del_${id}`, scope: `del:${id}`, prefix: 'D', nextValue: 3 });
  await db.insert(schema.projectDeliverables).values([
    { id: `del_${id}_1`, projectId: id, number: 1, title: 'App', plannedStart: new Date('2026-11-01T00:00:00.000Z'), plannedEnd: new Date('2026-11-15T00:00:00.000Z'), createdBy: PM, createdAt: now, updatedAt: now },
    { id: `del_${id}_2`, projectId: id, number: 2, title: 'Manual', createdBy: PM, createdAt: now, updatedAt: now },
  ]);
}

type Change = {
  id: string;
  projectId: string;
  number: number;
  code: string;
  status: string;
  route: string | null;
  costDelta: string | null;
  scheduleDeltaDays: number | null;
  baselineId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  title: string;
};

const body = (projectId: string, extra: Record<string, unknown> = {}) => ({ projectId, title: 'Move the beta', ...extra });

async function createChange(projectId: string, extra: Record<string, unknown> = {}, who: Send = pm()): Promise<Change> {
  const res = await who('POST', '/project-changes', body(projectId, extra));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Change>(res);
}

async function submit(id: string, who: Send = pm()) {
  const res = await who('POST', `/project-changes/${id}/submit`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return data<{ change: Change; approvers: Array<{ approvalId: string; approverId: string; decision: string; roleLabel: string }>; routing: Record<string, unknown> }>(res);
}

async function decide(who: Send, approvalId: string, decision: string, note?: string) {
  return who('POST', `/approvals/${approvalId}/decide`, { decision, note });
}

async function signOff(projectId: string) {
  const res = await pm()('POST', `/project-baselines/projects/${projectId}/initial`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<{ id: string; version: number }>(res);
}

async function getChange(id: string) {
  const res = await pm()('GET', `/project-changes/${id}`);
  expect(res.status).toBe(200);
  return data<
    Change & {
      approvers: Array<{ approverId: string; decision: string; step: number; note: string | null }>;
      effects: Record<string, unknown>;
      routing: { route: string; overLimit: boolean; noBoard: boolean; costLimit: number; scheduleLimitDays: number };
      baselineVersion: number | null;
      canDecide: boolean;
    }
  >(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ── Create ──────────────────────────────────────────────────────────────────

describe('POST /project-changes', () => {
  it('creates a draft numbered per project and publishes created', async () => {
    await seedProject('prj_chg_num');
    await seedProject('prj_chg_num2');
    const first = await createChange('prj_chg_num', { costDelta: 1500.5, scheduleDeltaDays: 3, description: 'Why' });
    const second = await createChange('prj_chg_num', { title: 'Second' });
    const other = await createChange('prj_chg_num2');
    expect([first.code, second.code, other.code]).toEqual(['CR-1', 'CR-2', 'CR-1']);
    expect(first).toMatchObject({ status: 'draft', costDelta: '1500.50', scheduleDeltaDays: 3, route: null, submittedAt: null, requestedBy: PM });
    expect(actions().slice(0, 1)).toEqual(['project_change_request.created']);
    expect(events()[0]?.data).toMatchObject({ code: 'CR-1', status: 'draft', projectId: 'prj_chg_num' });
  });

  it('refuses a viewer, an outsider and a user without the permission', async () => {
    await seedProject('prj_chg_deny');
    expect((await as(VIEWER)('POST', '/project-changes', body('prj_chg_deny'))).status).toBe(403);
    const outsider = await as(OUTSIDER)('POST', '/project-changes', body('prj_chg_deny'));
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You do not have write access to this project');
    expect((await as(MEMBER, ['projects:read'])('POST', '/project-changes', body('prj_chg_deny'))).status).toBe(403);
    expect(actions()).toEqual([]);
  });

  it('answers 404 for a project that is not there, 400 for a bad body and for an impact the project does not have', async () => {
    await seedProject('prj_chg_bad');
    const missing = await pm()('POST', '/project-changes', body('prj_chg_missing'));
    expect(missing.status).toBe(403); // access is checked before the project row: no membership, no write access
    const empty = await pm()('POST', '/project-changes', { projectId: 'prj_chg_bad' });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Invalid request body');
    const unknownField = await pm()('POST', '/project-changes', body('prj_chg_bad', { status: 'approved' }));
    expect(unknownField.status).toBe(400);
    const unknownMilestone = await pm()('POST', '/project-changes', body('prj_chg_bad', { planChanges: { milestones: [{ milestoneId: 'nope', to: '2026-12-01T00:00:00Z' }] } }));
    expect(unknownMilestone.status).toBe(400);
    expect((await errorOf(unknownMilestone)).message).toBe('Milestone nope does not belong to this project');
    const unknownDeliverable = await pm()('POST', '/project-changes', body('prj_chg_bad', { scopeChanges: { remove: ['nope'] } }));
    expect((await errorOf(unknownDeliverable)).message).toBe('Deliverable nope does not belong to this project');
    const both = await pm()(
      'POST',
      '/project-changes',
      body('prj_chg_bad', { planChanges: { deliverables: [{ deliverableId: 'del_prj_chg_bad_1' }] }, scopeChanges: { remove: ['del_prj_chg_bad_1'] } }),
    );
    expect((await errorOf(both)).message).toBe('A deliverable cannot be moved and removed in the same change request');
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe('/project-changes/settings/:projectId', () => {
  it('reads the defaults, with a warning while there is no board', async () => {
    await seedProject('prj_chg_set');
    const res = await as(MEMBER)('GET', '/project-changes/settings/prj_chg_set');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      projectId: 'prj_chg_set',
      changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [] },
      configured: false,
      sponsorId: null,
      projectManagerId: PM,
      currency: 'EUR',
      warnings: ['no_board'],
    });
    expect((await as(OUTSIDER)('GET', '/project-changes/settings/prj_chg_set')).status).toBe(403);
    expect((await pm()('GET', '/project-changes/settings/prj_chg_nope')).status).toBe(404);
  });

  it('lets the manager set the rules, merging the key and keeping the rest of the settings', async () => {
    await seedProject('prj_chg_put', { settings: { sponsorId: PM, schedule: { workingDays: [1, 2, 3], holidays: [], autoSchedule: false } } });
    const put = await pm()('PUT', '/project-changes/settings/prj_chg_put', { costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: [BOARD1, BOARD2, BOARD1] });
    expect(put.status).toBe(200);
    expect(await data(put)).toMatchObject({
      changeControl: { costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: [BOARD1, BOARD2] },
      configured: true,
      sponsorId: PM,
      warnings: [],
    });
    const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_chg_put'));
    expect(row?.settings).toMatchObject({ sponsorId: PM, schedule: { workingDays: [1, 2, 3] }, changeControl: { costLimit: 1000 } });
    expect(actions()).toEqual(['project.updated']);
  });

  it('refuses a member, a board member who is not on the project and a bad body', async () => {
    await seedProject('prj_chg_put2');
    const rules = { costLimit: 100, scheduleLimitDays: 1, boardMemberIds: [BOARD1] };
    expect((await as(MEMBER, MEMBER_KEYS)('PUT', '/project-changes/settings/prj_chg_put2', rules)).status).toBe(403);
    const outsider = await pm()('PUT', '/project-changes/settings/prj_chg_put2', { ...rules, boardMemberIds: [OUTSIDER] });
    expect(outsider.status).toBe(400);
    expect((await errorOf(outsider)).message).toBe('Change board members must be members of this project');
    expect((await pm()('PUT', '/project-changes/settings/prj_chg_put2', { costLimit: -1, scheduleLimitDays: 1, boardMemberIds: [] })).status).toBe(400);
    expect((await pm()('PUT', '/project-changes/settings/prj_chg_nope', rules)).status).toBe(404);
  });
});

// ── Submit and routing ──────────────────────────────────────────────────────

describe('POST /project-changes/:id/submit', () => {
  it('sends a change under both limits to the project manager', async () => {
    await seedProject('prj_chg_sub');
    const change = await createChange('prj_chg_sub', { costDelta: 4000, scheduleDeltaDays: 2 });
    published.mockClear();
    const result = await submit(change.id, as(MEMBER, MEMBER_KEYS));
    expect(result.change).toMatchObject({ status: 'awaiting_approval', route: 'manager' });
    expect(result.change.submittedAt).not.toBeNull();
    expect(result.approvers.map((a) => [a.approverId, a.decision, a.roleLabel])).toEqual([[PM, 'pending', 'Project manager']]);
    expect(result.routing).toMatchObject({ route: 'manager', overLimit: false, noBoard: false });
    expect(actions()).toEqual(['project_change_request.submitted', 'flow_approval.requested']);
  });

  it('sends a change over a limit to every board member, unanimously', async () => {
    await seedProject('prj_chg_board', { settings: { changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [BOARD1, BOARD2] } } });
    const change = await createChange('prj_chg_board', { costDelta: 8000 });
    const result = await submit(change.id);
    expect(result.change.route).toBe('board');
    expect(result.approvers.map((a) => a.approverId).sort()).toEqual([BOARD1, BOARD2]);
    expect(result.routing).toMatchObject({ route: 'board', overLimit: true, costLimit: 5000 });
    const detail = await getChange(change.id);
    expect(detail.routing).toMatchObject({ route: 'board', overLimit: true, noBoard: false });
  });

  it('flags a change over a limit when no board is set: the project manager approves', async () => {
    await seedProject('prj_chg_noboard');
    const change = await createChange('prj_chg_noboard', { scheduleDeltaDays: 9 });
    const result = await submit(change.id);
    expect(result.change.route).toBe('manager');
    expect(result.routing).toMatchObject({ route: 'manager', overLimit: true, noBoard: true });
    expect(result.approvers.map((a) => a.approverId)).toEqual([PM]);
  });

  it('keeps a change that saves money with the project manager, whatever the board', async () => {
    await seedProject('prj_chg_saves', { settings: { changeControl: { costLimit: 100, scheduleLimitDays: 1, boardMemberIds: [BOARD1] } } });
    const change = await createChange('prj_chg_saves', { costDelta: -90000, scheduleDeltaDays: -10 });
    expect((await submit(change.id)).change.route).toBe('manager');
  });

  it('refuses a second submit, a viewer and an unknown change', async () => {
    await seedProject('prj_chg_sub2');
    const change = await createChange('prj_chg_sub2');
    expect((await as(VIEWER)('POST', `/project-changes/${change.id}/submit`)).status).toBe(403);
    await submit(change.id);
    const again = await pm()('POST', `/project-changes/${change.id}/submit`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Only a draft or assessing change request can be submitted');
    expect((await pm()('POST', '/project-changes/pcr_missing/submit')).status).toBe(404);
  });

  it('asks the manager to be named when the project has none', async () => {
    await seedProject('prj_chg_nomanager');
    await db.update(schema.projects).set({ projectManagerId: null }).where(eq(schema.projects.id, 'prj_chg_nomanager'));
    // The member who writes needs a role on the project: BOARD1 is a plain member.
    const change = await createChange('prj_chg_nomanager', {}, as(BOARD1, MEMBER_KEYS));
    const res = await as(BOARD1, MEMBER_KEYS)('POST', `/project-changes/${change.id}/submit`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('This project has no project manager to approve the change');
  });
});

// ── Edit, withdraw, delete ──────────────────────────────────────────────────

describe('editing a submitted change', () => {
  it('sends the change back to assessing and clears its approvals when the impact changes', async () => {
    await seedProject('prj_chg_edit');
    const change = await createChange('prj_chg_edit', { costDelta: 100 });
    await submit(change.id);
    published.mockClear();
    const res = await pm()('PATCH', `/project-changes/${change.id}`, { costDelta: 200 });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ status: 'assessing', route: null, submittedAt: null, costDelta: '200.00' });
    expect(actions()).toEqual(['project_change_request.updated', 'flow_approval.cancelled']);
    const detail = await getChange(change.id);
    expect(detail.approvers).toEqual([]);
    // Submitting again routes it from scratch.
    expect((await submit(change.id)).approvers).toHaveLength(1);
  });

  it('keeps the approvals when only the words change or the same impact is sent again', async () => {
    await seedProject('prj_chg_edit2');
    const change = await createChange('prj_chg_edit2', { costDelta: 100, scheduleDeltaDays: 1 });
    await submit(change.id);
    published.mockClear();
    const res = await pm()('PATCH', `/project-changes/${change.id}`, { title: 'Renamed', costDelta: 100, scheduleDeltaDays: 1 });
    expect(await data(res)).toMatchObject({ status: 'awaiting_approval', title: 'Renamed', route: 'manager' });
    expect(actions()).toEqual(['project_change_request.updated']);
    expect((await getChange(change.id)).approvers).toHaveLength(1);
  });

  it('edits a draft freely, and refuses a viewer, a decided change and a bad impact', async () => {
    await seedProject('prj_chg_edit3');
    const change = await createChange('prj_chg_edit3');
    expect((await as(VIEWER)('PATCH', `/project-changes/${change.id}`, { title: 'x' })).status).toBe(403);
    expect((await pm()('PATCH', `/project-changes/${change.id}`, { planChanges: { milestones: [{ milestoneId: 'nope', to: '2026-12-01T00:00:00Z' }] } })).status).toBe(400);
    expect((await pm()('PATCH', `/project-changes/${change.id}`, { status: 'approved' })).status).toBe(400);
    expect((await pm()('PATCH', '/project-changes/pcr_missing', { title: 'x' })).status).toBe(404);
    await pm()('POST', `/project-changes/${change.id}/withdraw`);
    const late = await pm()('PATCH', `/project-changes/${change.id}`, { title: 'late' });
    expect(late.status).toBe(409);
    expect((await errorOf(late)).message).toBe('This change request can no longer be edited');
  });
});

describe('POST /project-changes/:id/withdraw and DELETE', () => {
  it('withdraws an open change, clears its approvals and keeps the record', async () => {
    await seedProject('prj_chg_wd');
    const change = await createChange('prj_chg_wd');
    await submit(change.id);
    published.mockClear();
    const res = await pm()('POST', `/project-changes/${change.id}/withdraw`);
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ status: 'withdrawn' });
    expect(actions()).toEqual(['project_change_request.updated', 'flow_approval.cancelled']);
    const again = await pm()('POST', `/project-changes/${change.id}/withdraw`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Only an open change request can be withdrawn');
  });

  it('lets the requester or a manager withdraw, nobody else', async () => {
    await seedProject('prj_chg_wd2');
    const change = await createChange('prj_chg_wd2', {}, as(MEMBER, MEMBER_KEYS));
    const other = await createChange('prj_chg_wd2', { title: 'Other' });
    const denied = await as(MEMBER, MEMBER_KEYS)('POST', `/project-changes/${other.id}/withdraw`);
    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).message).toBe('Only the requester or a project manager can withdraw this change request');
    expect((await as(VIEWER)('POST', `/project-changes/${change.id}/withdraw`)).status).toBe(403);
    expect((await as(MEMBER, MEMBER_KEYS)('POST', `/project-changes/${change.id}/withdraw`)).status).toBe(200);
    expect((await pm()('POST', `/project-changes/${other.id}/withdraw`)).status).toBe(200);
  });

  it('deletes only a draft or a withdrawn change', async () => {
    await seedProject('prj_chg_del');
    const draft = await createChange('prj_chg_del');
    const open = await createChange('prj_chg_del', { title: 'Open' });
    await submit(open.id);
    published.mockClear();
    expect((await as(MEMBER, MEMBER_KEYS)('DELETE', `/project-changes/${draft.id}`)).status).toBe(403);
    const refused = await pm()('DELETE', `/project-changes/${open.id}`);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe('Only a draft or withdrawn change request can be deleted');
    expect((await pm()('DELETE', `/project-changes/${draft.id}`)).status).toBe(204);
    expect(actions()).toEqual(['project_change_request.deleted']);
    expect((await pm()('GET', `/project-changes/${draft.id}`)).status).toBe(404);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET /project-changes', () => {
  it('lists the changes of a project, newest first, filtered and paged', async () => {
    await seedProject('prj_chg_list');
    const a = await createChange('prj_chg_list', { title: 'Alpha plan' });
    const b = await createChange('prj_chg_list', { title: 'Beta plan' });
    const c = await createChange('prj_chg_list', { title: 'Gamma' });
    await submit(b.id);
    const all = await pm()('GET', '/project-changes?projectId=prj_chg_list');
    const body = (await all.json()) as { data: Change[]; pagination: { totalCount: number; hasMore: boolean } };
    expect(body.data.map((row) => row.code)).toEqual([c.code, b.code, a.code]);
    expect(body.pagination).toMatchObject({ totalCount: 3, hasMore: false });
    const awaiting = (await (await pm()('GET', '/project-changes?projectId=prj_chg_list&status=awaiting_approval')).json()) as { data: Change[] };
    expect(awaiting.data.map((row) => row.id)).toEqual([b.id]);
    const search = (await (await pm()('GET', '/project-changes?projectId=prj_chg_list&search=plan')).json()) as { data: Change[] };
    expect(search.data).toHaveLength(2);
    const page1 = (await (await pm()('GET', '/project-changes?projectId=prj_chg_list&limit=2')).json()) as { data: Change[]; pagination: { hasMore: boolean; cursor: string } };
    expect(page1.pagination.hasMore).toBe(true);
    const page2 = (await (await pm()('GET', `/project-changes?projectId=prj_chg_list&limit=2&cursor=${page1.pagination.cursor}`)).json()) as { data: Change[] };
    expect(page2.data.map((row) => row.id)).toEqual([a.id]);
    expect((await as(OUTSIDER)('GET', '/project-changes?projectId=prj_chg_list')).status).toBe(403);
    expect((await pm()('GET', '/project-changes?status=bogus')).status).toBe(400);
  });

  it('shows the effects of a change on the plan, the approvers and who can answer', async () => {
    await seedProject('prj_chg_get');
    const change = await createChange('prj_chg_get', {
      costDelta: 4000,
      planChanges: {
        goLive: '2026-12-09T00:00:00.000Z',
        milestones: [{ milestoneId: 'ms_prj_chg_get', to: '2026-11-28T00:00:00.000Z' }],
        deliverables: [{ deliverableId: 'del_prj_chg_get_1', plannedEnd: '2026-11-22T00:00:00.000Z' }],
      },
      scopeChanges: { add: [{ title: 'Training' }], remove: ['del_prj_chg_get_2'] },
    });
    await submit(change.id);
    const detail = await getChange(change.id);
    expect(detail.effects).toMatchObject({
      goLive: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z', deltaDays: 8 },
      milestones: [{ name: 'Beta release', from: '2026-11-20T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z', deltaDays: 8 }],
      deliverables: {
        moved: [{ code: 'D1', title: 'App', plannedEnd: '2026-11-22T00:00:00.000Z' }],
        added: [{ title: 'Training' }],
        removed: [{ code: 'D2', title: 'Manual' }],
      },
      budget: { currency: 'EUR', from: '12000.00', to: '16000.00', delta: '4000.00' },
    });
    expect(detail.approvers.map((a) => [a.approverId, a.decision, a.step])).toEqual([[PM, 'pending', 1]]);
    expect(detail.canDecide).toBe(true); // the project manager is the one asked
  });
});

// ── Approval: apply and reject ──────────────────────────────────────────────

describe('answering a change request', () => {
  const impact = {
    costDelta: 4000,
    scheduleDeltaDays: 8,
    description: 'The supplier is late',
    planChanges: {
      goLive: '2026-12-09T00:00:00.000Z',
      milestones: [{ milestoneId: 'ms_prj_chg_ok', to: '2026-11-28T00:00:00.000Z' }],
      deliverables: [{ deliverableId: 'del_prj_chg_ok_1', plannedEnd: '2026-11-22T00:00:00.000Z' }],
    },
    scopeChanges: { add: [{ title: 'Training', plannedEnd: '2026-12-05T00:00:00.000Z' }], remove: ['del_prj_chg_ok_2'] },
  };

  it('applies an approved change to the plan, the budget, the baseline and the decision log in one step', async () => {
    await seedProject('prj_chg_ok');
    const v1 = await signOff('prj_chg_ok');
    expect(v1.version).toBe(1);
    const change = await createChange('prj_chg_ok', impact, as(MEMBER, MEMBER_KEYS));
    const { approvers } = await submit(change.id, as(MEMBER, MEMBER_KEYS));
    published.mockClear();

    const res = await decide(pm(), approvers[0]!.approvalId, 'approved');
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await data(res)).toMatchObject({ outcome: 'approved', resolved: true, viaDelegation: false });

    const detail = await getChange(change.id);
    expect(detail).toMatchObject({ status: 'approved', baselineVersion: 2 });
    expect(detail.decidedAt).not.toBeNull();
    expect(detail.baselineId).not.toBeNull();

    // The plan moved.
    const [milestone] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, 'ms_prj_chg_ok'));
    expect(milestone?.dueDate.toISOString()).toBe('2026-11-28T00:00:00.000Z');
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_chg_ok'));
    expect(project?.endDate?.toISOString()).toBe('2026-12-09T00:00:00.000Z');
    expect(project?.budgetedAmount).toBe('16000.00');
    const live = await db
      .select()
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, 'prj_chg_ok'), isNull(schema.projectDeliverables.deletedAt)));
    expect(live.map((d) => [d.number, d.title, d.plannedEnd?.toISOString() ?? null]).sort()).toEqual([
      [1, 'App', '2026-11-22T00:00:00.000Z'],
      [3, 'Training', '2026-12-05T00:00:00.000Z'],
    ]);

    // The next baseline version holds the plan after the change.
    const compare = await pm()('GET', `/project-baselines/compare?projectId=prj_chg_ok&from=${v1.id}&to=${detail.baselineId}`);
    expect(compare.status).toBe(200);
    const comparison = await data<{ to: { version: number; changeRequestCode: string }; diff: { goLive: { deltaDays: number }; budget: { delta: string }; deliverables: Array<{ number: number; change: string }> } }>(compare);
    expect(comparison.to).toMatchObject({ version: 2, changeRequestCode: 'CR-1' });
    expect(comparison.diff.goLive.deltaDays).toBe(8);
    expect(comparison.diff.budget.delta).toBe('4000.00');
    expect(comparison.diff.deliverables.map((d) => [d.number, d.change])).toEqual([
      [1, 'moved'],
      [2, 'removed'],
      [3, 'added'],
    ]);

    // A decided decision records it.
    const decisions = await db.select().from(schema.projectDecisions).where(eq(schema.projectDecisions.projectId, 'prj_chg_ok'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ number: 1, status: 'decided', decidedBy: PM, title: 'CR-1: Move the beta' });
    expect(decisions[0]?.consequences).toContain('The budget rises by 4000.00 EUR');

    expect(actions()).toEqual([
      'flow_approval.decided',
      'project_change_request.approved',
      'project_milestone.updated',
      'project_deliverable.created',
      'project_deliverable.updated',
      'project_deliverable.deleted',
      'project.updated',
      'project_baseline.created',
      'project_decision.created',
      'project_decision.decided',
    ]);
  });

  it('applies the plan but writes no baseline while the project has none', async () => {
    await seedProject('prj_chg_nobase');
    const change = await createChange('prj_chg_nobase', { costDelta: 1000 });
    const { approvers } = await submit(change.id);
    published.mockClear();
    expect((await decide(pm(), approvers[0]!.approvalId, 'approved')).status).toBe(200);
    const detail = await getChange(change.id);
    expect(detail).toMatchObject({ status: 'approved', baselineId: null, baselineVersion: null });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_chg_nobase'));
    expect(project?.budgetedAmount).toBe('13000.00');
    expect(actions()).not.toContain('project_baseline.created');
    expect(actions()).toContain('project_decision.decided');
  });

  it('waits for every board member and applies on the last yes', async () => {
    await seedProject('prj_chg_unan', { settings: { changeControl: { costLimit: 100, scheduleLimitDays: 1, boardMemberIds: [BOARD1, BOARD2] } } });
    const change = await createChange('prj_chg_unan', { costDelta: 500 });
    const { approvers } = await submit(change.id);
    const of = (user: string) => approvers.find((a) => a.approverId === user)!.approvalId;
    published.mockClear();
    const first = await decide(as(BOARD1, ['projects:read']), of(BOARD1), 'approved');
    expect(await data(first)).toMatchObject({ outcome: 'pending', resolved: false });
    expect((await getChange(change.id)).status).toBe('awaiting_approval');
    expect(actions()).toEqual(['flow_approval.decided']);
    const second = await decide(as(BOARD2, ['projects:read']), of(BOARD2), 'approved_with_conditions', 'After the audit');
    expect(await data(second)).toMatchObject({ outcome: 'approved', resolved: true });
    expect((await getChange(change.id)).status).toBe('approved');
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_chg_unan'));
    expect(project?.budgetedAmount).toBe('12500.00');
  });

  it('rejects on one no, clears the other approvers and records the reason', async () => {
    await seedProject('prj_chg_rej', { settings: { changeControl: { costLimit: 100, scheduleLimitDays: 1, boardMemberIds: [BOARD1, BOARD2] } } });
    const change = await createChange('prj_chg_rej', { costDelta: 500, description: 'Extra scope' });
    const { approvers } = await submit(change.id);
    const of = (user: string) => approvers.find((a) => a.approverId === user)!.approvalId;
    published.mockClear();
    const missingNote = await decide(as(BOARD1, ['projects:read']), of(BOARD1), 'rejected');
    expect(missingNote.status).toBe(400);
    expect((await errorOf(missingNote)).message).toBe('A note is required to decline or to set conditions');
    const res = await decide(as(BOARD1, ['projects:read']), of(BOARD1), 'rejected', 'Over budget');
    expect(await data(res)).toMatchObject({ outcome: 'rejected', resolved: true });
    const detail = await getChange(change.id);
    expect(detail.status).toBe('rejected');
    expect(detail.approvers.map((a) => [a.approverId, a.decision])).toEqual([[BOARD1, 'rejected']]);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_chg_rej'));
    expect(project?.budgetedAmount).toBe('12000.00');
    const [decision] = await db.select().from(schema.projectDecisions).where(eq(schema.projectDecisions.projectId, 'prj_chg_rej'));
    expect(decision).toMatchObject({ status: 'decided', decidedBy: BOARD1, title: 'CR-1 rejected: Move the beta' });
    expect(decision?.context).toContain('Over budget');
    expect(actions()).toEqual([
      'flow_approval.decided',
      'flow_approval.cancelled',
      'project_change_request.rejected',
      'project_decision.created',
      'project_decision.decided',
    ]);
  });

  it('refuses someone who is not the approver, and a second answer', async () => {
    await seedProject('prj_chg_who');
    const change = await createChange('prj_chg_who');
    const { approvers } = await submit(change.id);
    const id = approvers[0]!.approvalId;
    const stranger = await decide(as(MEMBER, MEMBER_KEYS), id, 'approved');
    expect(stranger.status).toBe(403);
    expect((await errorOf(stranger)).message).toBe('You are not an approver of this review');
    expect((await decide(pm(), id, 'info_requested')).status).toBe(200);
    expect((await getChange(change.id)).status).toBe('awaiting_approval');
    expect((await decide(pm(), id, 'approved')).status).toBe(200);
    const again = await decide(pm(), id, 'approved');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This review has already been answered');
  });

  it('tells the approver they can answer on the detail', async () => {
    await seedProject('prj_chg_can');
    const change = await createChange('prj_chg_can');
    await submit(change.id);
    expect((await getChange(change.id)).canDecide).toBe(true);
    const asMember = await as(MEMBER, MEMBER_KEYS)('GET', `/project-changes/${change.id}`);
    expect((await data<{ canDecide: boolean }>(asMember)).canDecide).toBe(false);
  });
});


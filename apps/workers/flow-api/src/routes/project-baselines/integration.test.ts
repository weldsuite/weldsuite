/**
 * DB-backed integration tests for baselines: /api/project-baselines (sign-off
 * of v1, the list, one version and the comparison). The later versions are
 * produced by approved change requests and tested with them
 * (routes/project-changes). Runs against the TypeScript worker and, in
 * conformance mode, the Rust backend (rust/conformance/suites.json).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { projectChangesRoutes } from '../project-changes';
import { projectBaselinesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/project-baselines', projectBaselinesRoutes);
router.route('/project-changes', projectChangesRoutes);

const PM = 'user_bl_pm';
const MEMBER = 'user_bl_member';
const OUTSIDER = 'user_bl_outsider';
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api', router, { context: { userId, permissions: permissions(...keys), tenantDb: db } });
  return (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const pm = () => as(PM);
const data = async <T = Record<string, unknown>>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);

beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string, withPlan = true) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({
    id,
    name: id,
    projectManagerId: PM,
    budgetedAmount: '12000.00',
    budgetedHours: '300.00',
    budgetCurrency: 'EUR',
    endDate: withPlan ? new Date('2026-12-01T00:00:00.000Z') : null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectMembers).values({
    id: `pm_${id}_m`,
    projectId: id,
    userId: MEMBER,
    role: 'member',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    joinedAt: now,
  });
  if (!withPlan) return;
  await db.insert(schema.milestones).values([
    { id: `ms_${id}_1`, projectId: id, name: 'Alpha', dueDate: new Date('2026-11-10T00:00:00.000Z'), createdAt: now, updatedAt: now },
    { id: `ms_${id}_2`, projectId: id, name: 'Beta', dueDate: new Date('2026-11-20T00:00:00.000Z'), createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.projectDeliverables).values({
    id: `del_${id}_1`,
    projectId: id,
    number: 1,
    title: 'App',
    plannedStart: new Date('2026-11-01T00:00:00.000Z'),
    plannedEnd: new Date('2026-11-15T00:00:00.000Z'),
    createdBy: PM,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectScope).values({ id: `scope_${id}`, projectId: id, statement: 'Ship the app', createdBy: PM, createdAt: now, updatedAt: now });
}

type Baseline = {
  id: string;
  projectId: string;
  version: number;
  changeRequestId: string | null;
  changeRequestCode: string | null;
  snapshot: {
    goLive: string | null;
    milestones: Array<{ id: string; name: string; dueDate: string }>;
    deliverables: Array<{ id: string; number: number; title: string }>;
    budgetedAmount: string | null;
    budgetedHours: string | null;
    budgetCurrency: string | null;
    scopeStatement: string | null;
  };
  createdBy: string;
};

async function signOff(projectId: string): Promise<Baseline> {
  const res = await pm()('POST', `/project-baselines/projects/${projectId}/initial`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Baseline>(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('POST /project-baselines/projects/:projectId/initial', () => {
  it('signs off v1 from the current plan and publishes created', async () => {
    await seedProject('prj_bl_v1');
    const baseline = await signOff('prj_bl_v1');
    expect(baseline).toMatchObject({ projectId: 'prj_bl_v1', version: 1, changeRequestId: null, changeRequestCode: null, createdBy: PM });
    expect(baseline.snapshot).toEqual({
      goLive: '2026-12-01T00:00:00.000Z',
      milestones: [
        { id: 'ms_prj_bl_v1_1', name: 'Alpha', dueDate: '2026-11-10T00:00:00.000Z' },
        { id: 'ms_prj_bl_v1_2', name: 'Beta', dueDate: '2026-11-20T00:00:00.000Z' },
      ],
      deliverables: [{ id: 'del_prj_bl_v1_1', number: 1, title: 'App', plannedStart: '2026-11-01T00:00:00.000Z', plannedEnd: '2026-11-15T00:00:00.000Z' }],
      budgetedAmount: '12000.00',
      budgetedHours: '300.00',
      budgetCurrency: 'EUR',
      scopeStatement: 'Ship the app',
    });
    expect(actions()).toEqual(['project_baseline.created']);
  });

  it('signs off once only', async () => {
    await seedProject('prj_bl_once');
    await signOff('prj_bl_once');
    const again = await pm()('POST', '/project-baselines/projects/prj_bl_once/initial');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This project already has a baseline');
  });

  it('refuses a plan with nothing in it, a plain member, an outsider and an unknown project', async () => {
    await seedProject('prj_bl_empty', false);
    const empty = await pm()('POST', '/project-baselines/projects/prj_bl_empty/initial');
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Add a milestone, a deliverable or an end date before signing off the baseline');
    await seedProject('prj_bl_deny');
    expect((await as(MEMBER)('POST', '/project-baselines/projects/prj_bl_deny/initial')).status).toBe(403);
    expect((await as(OUTSIDER)('POST', '/project-baselines/projects/prj_bl_deny/initial')).status).toBe(403);
    expect((await as(MEMBER, ['projects:read'])('POST', '/project-baselines/projects/prj_bl_deny/initial')).status).toBe(403);
    expect((await pm()('POST', '/project-baselines/projects/prj_bl_nope/initial')).status).toBe(404);
    expect(actions()).toEqual([]);
  });
});

describe('GET /project-baselines', () => {
  it('lists the versions of a project newest first and reads one', async () => {
    await seedProject('prj_bl_list');
    const v1 = await signOff('prj_bl_list');
    const list = (await (await pm()('GET', '/project-baselines?projectId=prj_bl_list')).json()) as { data: Baseline[]; pagination: { totalCount: number } };
    expect(list.data.map((row) => row.version)).toEqual([1]);
    expect(list.pagination.totalCount).toBe(1);
    const one = await as(MEMBER)('GET', `/project-baselines/${v1.id}`);
    expect(one.status).toBe(200);
    expect((await data<Baseline>(one)).snapshot.deliverables).toHaveLength(1);
    expect((await as(OUTSIDER)('GET', `/project-baselines/${v1.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('GET', '/project-baselines?projectId=prj_bl_list')).status).toBe(403);
    expect((await pm()('GET', '/project-baselines/bsl_missing')).status).toBe(404);
    // Across projects the list covers only the caller's own.
    const mine = (await (await as(OUTSIDER)('GET', '/project-baselines')).json()) as { data: Baseline[] };
    expect(mine.data).toEqual([]);
  });
});

describe('GET /project-baselines/compare', () => {
  it('compares the latest version with the live plan: slip, added and removed, budget', async () => {
    await seedProject('prj_bl_cmp');
    const v1 = await signOff('prj_bl_cmp');
    // The live plan drifts: Beta slips 8 days, a milestone appears, the deliverable ends later, the budget rises.
    await db.update(schema.milestones).set({ dueDate: new Date('2026-11-28T00:00:00.000Z') }).where(eq(schema.milestones.id, 'ms_prj_bl_cmp_2'));
    await db.insert(schema.milestones).values({ id: 'ms_prj_bl_cmp_3', projectId: 'prj_bl_cmp', name: 'Gamma', dueDate: new Date('2026-12-05T00:00:00.000Z'), createdAt: new Date(), updatedAt: new Date() });
    await db.update(schema.projectDeliverables).set({ plannedEnd: new Date('2026-11-22T00:00:00.000Z') }).where(eq(schema.projectDeliverables.id, 'del_prj_bl_cmp_1'));
    await db.update(schema.projects).set({ endDate: new Date('2026-12-09T00:00:00.000Z'), budgetedAmount: '20000.00' }).where(eq(schema.projects.id, 'prj_bl_cmp'));

    const res = await pm()('GET', '/project-baselines/compare?projectId=prj_bl_cmp');
    expect(res.status).toBe(200);
    const body = await data<{
      from: Baseline;
      to: Baseline | null;
      diff: {
        goLive: { from: string; to: string; deltaDays: number };
        milestones: Array<{ name: string; change: string; deltaDays: number | null }>;
        deliverables: Array<{ title: string; change: string; end: { deltaDays: number | null } }>;
        budget: { from: string; to: string; delta: string };
      };
      pending: unknown[];
    }>(res);
    expect(body.from.id).toBe(v1.id);
    expect(body.to).toBeNull();
    expect(body.diff.goLive).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z', deltaDays: 8 });
    expect(body.diff.milestones.map((m) => [m.name, m.change, m.deltaDays])).toEqual([
      ['Alpha', 'unchanged', 0],
      ['Beta', 'moved', 8],
      ['Gamma', 'added', null],
    ]);
    expect(body.diff.deliverables.map((d) => [d.title, d.change, d.end.deltaDays])).toEqual([['App', 'moved', 7]]);
    expect(body.diff.budget).toEqual({ from: '12000.00', to: '20000.00', delta: '8000.00' });
    expect(body.pending).toEqual([]);
  });

  it('previews the open change requests on the live plan', async () => {
    await seedProject('prj_bl_pend');
    await signOff('prj_bl_pend');
    const created = await pm()('POST', '/project-changes', {
      projectId: 'prj_bl_pend',
      title: 'Move beta',
      planChanges: { goLive: '2026-12-15T00:00:00.000Z', milestones: [{ milestoneId: 'ms_prj_bl_pend_2', to: '2026-11-30T00:00:00.000Z' }], deliverables: [{ deliverableId: 'del_prj_bl_pend_1', plannedEnd: '2026-11-25T00:00:00.000Z' }] },
    });
    const change = await data<{ id: string; code: string }>(created);
    await pm()('POST', `/project-changes/${change.id}/submit`);
    const res = await pm()('GET', '/project-baselines/compare?projectId=prj_bl_pend');
    const body = await data<{ pending: Array<Record<string, unknown>> }>(res);
    expect(body.pending).toEqual([
      {
        changeRequestId: change.id,
        code: change.code,
        title: 'Move beta',
        status: 'awaiting_approval',
        milestones: [{ milestoneId: 'ms_prj_bl_pend_2', name: 'Beta', from: '2026-11-20T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }],
        deliverables: [{ deliverableId: 'del_prj_bl_pend_1', plannedStart: '2026-11-01T00:00:00.000Z', plannedEnd: '2026-11-25T00:00:00.000Z' }],
        goLive: '2026-12-15T00:00:00.000Z',
      },
    ]);
  });

  it('compares two versions, and refuses a missing, foreign or unspecified baseline', async () => {
    await seedProject('prj_bl_two');
    await seedProject('prj_bl_other');
    const v1 = await signOff('prj_bl_two');
    const other = await signOff('prj_bl_other');
    const self = await pm()('GET', `/project-baselines/compare?from=${v1.id}&to=${v1.id}`);
    expect(self.status).toBe(200);
    expect((await data<{ to: Baseline }>(self)).to.version).toBe(1);
    const foreign = await pm()('GET', `/project-baselines/compare?from=${v1.id}&to=${other.id}`);
    expect(foreign.status).toBe(400);
    expect((await errorOf(foreign)).message).toBe('The two baselines belong to different projects');
    expect((await pm()('GET', '/project-baselines/compare?from=bsl_missing')).status).toBe(404);
    expect((await pm()('GET', `/project-baselines/compare?from=${v1.id}&to=bsl_missing`)).status).toBe(404);
    const none = await pm()('GET', '/project-baselines/compare');
    expect(none.status).toBe(400);
    expect((await errorOf(none)).message).toBe('Choose a project or a baseline to compare');
    expect((await as(OUTSIDER)('GET', `/project-baselines/compare?from=${v1.id}`)).status).toBe(403);
    await seedProject('prj_bl_nobase');
    expect((await pm()('GET', '/project-baselines/compare?projectId=prj_bl_nobase')).status).toBe(404);
  });
});

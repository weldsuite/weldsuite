/**
 * DB-backed integration tests for benefits: /api/project-benefits, the goal
 * targets and the monthly sweep. Runs against the TypeScript worker and, in
 * conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { measureDueBenefits, nextBenefitMeasureDueAt } from '../../cron/benefit-measure';
import { projectBenefitsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_ben_manager';
const VIEWER = 'user_ben_viewer';
const OUTSIDER = 'user_ben_outsider';
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

function as(userId: string, keys: string[] = FULL) {
  const { request } = createTestApp('/api/project-benefits', projectBenefitsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/project-benefits${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
const manager = () => as(MANAGER);
const data = async <T = Record<string, unknown>>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { message: string } }).error;

type Benefit = {
  id: string;
  code: string;
  status: string;
  metric: string;
  metricParams: Record<string, unknown>;
  unit: string | null;
  baselineValue: string | null;
  targetValue: string | null;
  closedAt: string | null;
  latest: { period: string; value: string } | null;
  progressPct: number | null;
};

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);
beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values({ id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now });
}

async function create(projectId: string, body: Record<string, unknown> = {}): Promise<Benefit> {
  const res = await manager()('POST', '', { projectId, title: 'Fewer order-status questions', ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Benefit>(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('POST /', () => {
  it('numbers B-n per project, takes the catalogue unit and checks the metric parameters', async () => {
    await seedProject('prj_ben_1');
    const a = await create('prj_ben_1', { metric: 'desk_tickets_by_tag', metricParams: { tag: ' order status ' }, baselineValue: 1150, targetValue: 400 });
    const b = await create('prj_ben_1', { title: 'Manual' });
    expect([a.code, b.code]).toEqual(['B-1', 'B-2']);
    expect(a).toMatchObject({ status: 'planned', unit: 'tickets', metricParams: { tag: 'order status' }, baselineValue: '1150.0000', targetValue: '400.0000', latest: null, progressPct: null });
    expect(b).toMatchObject({ metric: 'manual', metricParams: {} });
    expect(actions()).toEqual(['project_benefit.created', 'project_benefit.created']);

    const send = manager();
    const bad = async (body: Record<string, unknown>) => {
      const res = await send('POST', '', { projectId: 'prj_ben_1', title: 'x', ...body });
      return [res.status, (await errorOf(res)).message];
    };
    expect(await bad({ metric: 'desk_tickets_by_tag' })).toEqual([400, "Invalid parameters for the 'desk_tickets_by_tag' metric"]);
    expect(await bad({ metric: 'nope' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ status: 'realised' })).toEqual([400, 'Invalid request body']);
    expect((await as(VIEWER)('POST', '', { projectId: 'prj_ben_1', title: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('POST', '', { projectId: 'prj_ben_1', title: 'x' })).status).toBe(403);
  });
});

describe('measurements', () => {
  it('stores a manual value per month, replaces it, and shows the progress toward the target', async () => {
    await seedProject('prj_ben_2');
    const benefit = await create('prj_ben_2', { baselineValue: 35, targetValue: 70, unit: '%' });
    published.mockClear();
    const first = await manager()('POST', `/${benefit.id}/measurements`, { period: '2026-09', value: 35 });
    expect(first.status).toBe(201);
    const second = await manager()('POST', `/${benefit.id}/measurements`, { period: '2026-10', value: 36 });
    const result = await data<{ measurement: { period: string; value: string; measuredBy: string }; benefit: Benefit }>(second);
    expect(result.measurement).toMatchObject({ period: '2026-10', value: '36.0000', measuredBy: MANAGER });
    expect(result.benefit).toMatchObject({ status: 'measuring', latest: { period: '2026-10', value: '36.0000' }, progressPct: 3 });
    await manager()('POST', `/${benefit.id}/measurements`, { period: '2026-10', value: 40 });
    expect(actions()).toEqual(Array(3).fill('project_benefit.updated'));

    const detail = await data<Benefit & { measurements: Array<{ period: string; value: string }> }>(await manager()('GET', `/${benefit.id}`));
    expect(detail.measurements.map((m) => [m.period, m.value])).toEqual([['2026-09', '35.0000'], ['2026-10', '40.0000']]);
    const listed = (await (await manager()('GET', `/${benefit.id}/measurements`)).json()) as { data: unknown[]; pagination: { totalCount: number } };
    expect(listed.pagination.totalCount).toBe(2);

    const future = await manager()('POST', `/${benefit.id}/measurements`, { period: '2099-01', value: 1 });
    expect([future.status, (await errorOf(future)).message]).toEqual([400, 'period cannot be in the future']);
    expect((await manager()('POST', `/${benefit.id}/measurements`, { period: '2026-13', value: 1 })).status).toBe(400);
    expect((await as(VIEWER)('POST', `/${benefit.id}/measurements`, { period: '2026-10', value: 1 })).status).toBe(403);
    expect((await as(VIEWER)('GET', `/${benefit.id}/measurements`)).status).toBe(200);
  });
});

describe('PATCH, GET list and DELETE', () => {
  it('ends the measuring on realised and publishes realised, resumes on reopening', async () => {
    await seedProject('prj_ben_3');
    const benefit = await create('prj_ben_3', { metric: 'books_days_to_pay' });
    published.mockClear();
    const res = await manager()('PATCH', `/${benefit.id}`, { status: 'realised' });
    const realised = await data<Benefit>(res);
    expect(realised.status).toBe('realised');
    expect(realised.closedAt).not.toBeNull();
    expect(actions()).toEqual(['project_benefit.updated', 'project_benefit.realised']);
    const reopened = await data<Benefit>(await manager()('PATCH', `/${benefit.id}`, { status: 'at_risk' }));
    expect(reopened.closedAt).toBeNull();

    const changed = await manager()('PATCH', `/${benefit.id}`, { metric: 'books_supplier_cost' });
    expect([changed.status, (await errorOf(changed)).message]).toEqual([400, "Invalid parameters for the 'books_supplier_cost' metric"]);
    const ok = await data<Benefit>(await manager()('PATCH', `/${benefit.id}`, { metric: 'books_supplier_cost', metricParams: { supplierId: 'con_1' } }));
    expect(ok.metricParams).toEqual({ supplierId: 'con_1' });
    expect((await as(VIEWER)('PATCH', `/${benefit.id}`, { title: 'x' })).status).toBe(403);
    expect((await manager()('PATCH', '/ben_nope', { title: 'x' })).status).toBe(404);

    const list = (await (await manager()('GET', '?projectId=prj_ben_3&status=at_risk')).json()) as { data: Benefit[] };
    expect(list.data.map((b) => b.id)).toEqual([benefit.id]);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_ben_3')).status).toBe(403);

    expect((await as(VIEWER)('DELETE', `/${benefit.id}`)).status).toBe(403);
    expect((await manager()('DELETE', `/${benefit.id}`)).status).toBe(204);
    expect((await manager()('GET', `/${benefit.id}`)).status).toBe(404);
  });
});

describe('GET /goal-targets', () => {
  it('computes progress for benefit and task targets on goal cards', async () => {
    await seedProject('prj_ben_4');
    const benefit = await create('prj_ben_4', { baselineValue: 100, targetValue: 0 });
    await manager()('POST', `/${benefit.id}/measurements`, { period: '2026-10', value: 75 });
    await db.insert(schema.tasks).values([
      { id: 'task_ben_1', title: 'a', projectId: 'prj_ben_4', milestoneId: 'ms_x', status: 'done' },
      { id: 'task_ben_2', title: 'b', projectId: 'prj_ben_4', milestoneId: 'ms_x', status: 'todo' },
      { id: 'task_ben_3', title: 'c', projectId: 'prj_ben_4', milestoneId: 'ms_x', status: 'cancelled' },
    ]);
    await db.insert(schema.projectGoals).values({
      id: 'goal_ben_4',
      projectId: 'prj_ben_4',
      goals: [
        { id: 'g1', targets: [{ benefitId: benefit.id }, { benefitId: 'ben_gone' }, { label: 'Milestone work', taskFilter: { milestoneId: 'ms_x' } }, { bad: true }] },
        { id: 'g2' },
        { targets: [{ benefitId: benefit.id }] },
      ],
    });
    const res = await manager()('GET', '/goal-targets?projectId=prj_ben_4');
    expect(res.status).toBe(200);
    const cards = await data<Array<{ goalId: string; targets: Array<Record<string, unknown>> }>>(res);
    expect(cards.map((c) => c.goalId)).toEqual(['g1']);
    expect(cards[0]?.targets).toMatchObject([
      { index: 0, kind: 'benefit', code: 'B-1', currentValue: '75.0000', progressPct: 25 },
      { index: 1, kind: 'benefit', benefitId: 'ben_gone', progressPct: null, code: null },
      { index: 2, kind: 'task', label: 'Milestone work', done: 1, total: 2, progressPct: 50 },
    ]);
    expect((await manager()('GET', '/goal-targets')).status).toBe(400);
    expect((await as(OUTSIDER)('GET', '/goal-targets?projectId=prj_ben_4')).status).toBe(403);
    expect((await manager()('GET', '/goal-targets?projectId=prj_ben_missing')).status).toBe(404);
  });
});

describe('the monthly sweep', () => {
  it('measures open catalogue benefits for the previous month, keeps manual values and skips closed ones', async () => {
    await seedProject('prj_ben_5');
    const tickets = await create('prj_ben_5', { metric: 'desk_tickets_by_tag', metricParams: { tag: 'sweep' } });
    const typed = await create('prj_ben_5', { metric: 'desk_tickets_by_tag', metricParams: { tag: 'sweep' }, title: 'Typed' });
    const closed = await create('prj_ben_5', { metric: 'desk_tickets_by_tag', metricParams: { tag: 'sweep' }, title: 'Closed' });
    const manual = await create('prj_ben_5', { title: 'Manual' });
    await manager()('PATCH', `/${closed.id}`, { status: 'closed' });
    await manager()('POST', `/${typed.id}/measurements`, { period: '2026-10', value: 7 });
    await db.insert(schema.helpdeskTickets).values({
      id: 't_sweep_1', ticketNumber: 't_sweep_1', customerName: 'C', customerEmail: 'c@example.com', subject: 's', tags: ['sweep'], createdAt: new Date('2026-10-05T10:00:00.000Z'),
    });

    const now = new Date('2026-11-01T03:30:00.000Z');
    // Every open benefit of the workspace counts, the ones of the earlier tests too.
    expect(await measureDueBenefits(db, now)).toBeGreaterThanOrEqual(2);
    expect(await measureDueBenefits(db, now)).toBeGreaterThanOrEqual(2);

    const read = async (id: string) => data<Benefit>(await manager()('GET', `/${id}`));
    expect(await read(tickets.id)).toMatchObject({ status: 'measuring', latest: { period: '2026-10', value: '1.0000' } });
    // A value somebody typed in for the month is not overwritten.
    expect((await read(typed.id)).latest).toMatchObject({ period: '2026-10', value: '7.0000' });
    expect((await read(closed.id)).latest).toBeNull();
    expect((await read(manual.id)).latest).toBeNull();

    expect((await nextBenefitMeasureDueAt(db, now))?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

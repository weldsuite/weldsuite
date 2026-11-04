/**
 * DB-backed integration tests for the computed schedule (delivery,
 * scheduling): /api/project-schedule. Runs against the TypeScript worker and,
 * in conformance mode, the Rust backend (rust/conformance/suites.json), so
 * every status code, message and event payload asserted here is the contract
 * of both. The calculation itself is covered by the shared fixtures of
 * packages/domains/flow/src/testing/schedule-fixtures.json.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectScheduleRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_sch_manager';
const MEMBER = 'user_sch_member';
const VIEWER = 'user_sch_viewer';
const OUTSIDER = 'user_sch_outsider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-schedule', projectScheduleRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-schedule${path}`, {
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

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

const day = (date: string, time = '00:00:00.000') => new Date(`${date}T${time}Z`);

async function seedProject(id: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, createdAt: now, updatedAt: now, ...extra });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function seedTask(id: string, projectId: string, start: string | null, due: string | null, extra: Record<string, unknown> = {}) {
  await db.insert(schema.tasks).values({
    id,
    title: `Task ${id}`,
    projectId,
    startDate: start ? day(start, '09:30:00.000') : null,
    dueDate: due ? day(due, '17:00:00.000') : null,
    ...extra,
  } as typeof schema.tasks.$inferInsert);
}

async function seedLink(id: string, projectId: string, predecessorId: string, successorId: string, type: 'fs' | 'ss' | 'ff' | 'sf' = 'fs', lagDays = 0) {
  await db.insert(schema.taskDependencies).values({ id, projectId, predecessorId, successorId, type, lagDays, createdBy: MANAGER });
}

/** Task numbers are unique in the workspace. */
let nextNumber = 7000;

/** A (2-6 Nov) -> B (9-10 Nov) -> C (11-13 Nov), and X alone, with go-live on 20 Nov from baseline v1. Returns the number of A; B is the next. */
async function seedChain(projectId: string, options: { autoSchedule?: boolean; baseline?: boolean } = {}): Promise<number> {
  const first = nextNumber;
  nextNumber += 4;
  await seedProject(projectId, {
    settings: options.autoSchedule === undefined ? null : { schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: options.autoSchedule } },
  });
  await seedTask(`${projectId}_a`, projectId, '2026-11-02', '2026-11-06', { status: 'in_progress', number: first });
  await seedTask(`${projectId}_b`, projectId, '2026-11-09', '2026-11-10', { number: first + 1 });
  await seedTask(`${projectId}_c`, projectId, '2026-11-11', '2026-11-13', { number: first + 2 });
  await seedTask(`${projectId}_x`, projectId, '2026-11-02', '2026-11-03', { number: first + 3 });
  await seedLink(`tdp_${projectId}_1`, projectId, `${projectId}_a`, `${projectId}_b`);
  await seedLink(`tdp_${projectId}_2`, projectId, `${projectId}_b`, `${projectId}_c`);
  if (options.baseline !== false) {
    await db.insert(schema.projectBaselines).values({
      id: `bl_${projectId}`,
      projectId,
      version: 1,
      snapshot: {
        goLive: '2026-11-20T00:00:00.000Z',
        milestones: [],
        deliverables: [],
        budgetedAmount: null,
        budgetedHours: null,
        budgetCurrency: null,
        scopeStatement: null,
      },
      createdBy: MANAGER,
    });
  }
  return first;
}

interface ScheduleTask {
  id: string;
  number: number | null;
  startDate: string | null;
  dueDate: string | null;
  scheduled: boolean;
  plannedStart: string | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  critical: boolean;
  shiftDays: number;
  linked: boolean;
}

interface Schedule {
  projectId: string;
  settings: { workingDays: number[]; holidays: string[]; autoSchedule: boolean };
  goLive: { date: string | null; source: string | null; baselineVersion: number | null };
  finish: string | null;
  goLiveSlackDays: number | null;
  scheduleLimitDays: number;
  tasks: ScheduleTask[];
  dependencies: Array<{ id: string; predecessorId: string; successorId: string; type: string; lagDays: number }>;
  conflicts: Array<{ linkId: string; requiredStart: string; shortByDays: number }>;
  criticalPath: string[];
  cyclicTaskIds: string[];
  deliverables: Array<{ id: string; code: string; plannedEnd: string | null; projectedEnd: string | null; slipDays: number | null }>;
  summary: Record<string, number | null>;
}

// ── GET /:projectId ─────────────────────────────────────────────────────────

describe('GET /:projectId', () => {
  it('answers the early and late dates, float, critical path and go-live float of the network', async () => {
    const first = await seedChain('prj_sch_get');

    const res = await manager()('GET', '/prj_sch_get');
    expect(res.status).toBe(200);
    const schedule = await data<Schedule>(res);

    expect(schedule.projectId).toBe('prj_sch_get');
    expect(schedule.settings).toEqual({ workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false });
    expect(schedule.goLive).toEqual({ date: '2026-11-20', source: 'baseline', baselineVersion: 1 });
    expect(schedule.finish).toBe('2026-11-13');
    expect(schedule.goLiveSlackDays).toBe(5);
    expect(schedule.scheduleLimitDays).toBe(5);
    expect(schedule.criticalPath).toEqual([`prj_sch_get_a`, `prj_sch_get_b`, `prj_sch_get_c`]);
    expect(schedule.conflicts).toEqual([]);
    expect(schedule.cyclicTaskIds).toEqual([]);
    expect(schedule.dependencies.map((link) => [link.predecessorId, link.successorId, link.type, link.lagDays])).toEqual([
      ['prj_sch_get_a', 'prj_sch_get_b', 'fs', 0],
      ['prj_sch_get_b', 'prj_sch_get_c', 'fs', 0],
    ]);

    // Tasks in start order (X and A start on 2 Nov, X is due first), with what was stored and what was computed.
    const byId = new Map(schedule.tasks.map((task) => [task.id, task]));
    expect(schedule.tasks.map((task) => task.id)).toEqual(['prj_sch_get_x', 'prj_sch_get_a', 'prj_sch_get_b', 'prj_sch_get_c']);
    expect(byId.get('prj_sch_get_b')).toMatchObject({
      number: first + 1,
      startDate: '2026-11-09T09:30:00.000Z',
      dueDate: '2026-11-10T17:00:00.000Z',
      scheduled: true,
      plannedStart: '2026-11-09',
      earlyStart: '2026-11-09',
      earlyFinish: '2026-11-10',
      totalFloat: 0,
      critical: true,
      shiftDays: 0,
      linked: true,
    });
    // X is not linked: it has float to the project finish and is never critical.
    expect(byId.get('prj_sch_get_x')).toMatchObject({ critical: false, linked: false, totalFloat: 8 });
    expect(schedule.summary).toEqual({
      taskCount: 4,
      scheduledCount: 4,
      unlinkedCount: 1,
      linkCount: 2,
      criticalCount: 3,
      criticalSpanDays: 10,
      conflictCount: 0,
    });
  });

  it('flags a successor planned before its predecessor allows, and its early date shows the push', async () => {
    await seedProject('prj_sch_conf');
    await seedTask('prj_sch_conf_a', 'prj_sch_conf', '2026-11-02', '2026-11-06');
    await seedTask('prj_sch_conf_b', 'prj_sch_conf', '2026-11-04', '2026-11-05');
    await seedLink('tdp_sch_conf', 'prj_sch_conf', 'prj_sch_conf_a', 'prj_sch_conf_b');

    const schedule = await data<Schedule>(await manager()('GET', '/prj_sch_conf'));
    expect(schedule.conflicts).toEqual([
      expect.objectContaining({ linkId: 'tdp_sch_conf', requiredStart: '2026-11-09', plannedStart: '2026-11-04', shortByDays: 3 }),
    ]);
    expect(schedule.tasks.find((task) => task.id === 'prj_sch_conf_b')).toMatchObject({ plannedStart: '2026-11-04', earlyStart: '2026-11-09', shiftDays: 3 });
    expect(schedule.summary.conflictCount).toBe(1);
  });

  it("takes the go-live from the project's end date without a baseline, and none without either", async () => {
    await seedProject('prj_sch_end', { endDate: day('2026-12-01') });
    await seedTask('prj_sch_end_a', 'prj_sch_end', '2026-11-02', '2026-11-06');
    await seedProject('prj_sch_noend');

    const withEnd = await data<Schedule>(await manager()('GET', '/prj_sch_end'));
    expect(withEnd.goLive).toEqual({ date: '2026-12-01', source: 'project', baselineVersion: null });
    expect(withEnd.goLiveSlackDays).toBe(17);
    const without = await data<Schedule>(await manager()('GET', '/prj_sch_noend'));
    expect(without).toMatchObject({ goLive: { date: null, source: null }, finish: null, goLiveSlackDays: null, tasks: [], criticalPath: [] });
    expect(without.summary).toMatchObject({ taskCount: 0, criticalSpanDays: null });
  });

  it('reads the project calendar: working days and holidays', async () => {
    await seedProject('prj_sch_cal', { settings: { schedule: { workingDays: [1, 2, 3, 4, 5], holidays: ['2026-11-09'], autoSchedule: false } } });
    await seedTask('prj_sch_cal_a', 'prj_sch_cal', '2026-11-06', '2026-11-06');
    await seedTask('prj_sch_cal_b', 'prj_sch_cal', '2026-11-06', '2026-11-06');
    await seedLink('tdp_sch_cal', 'prj_sch_cal', 'prj_sch_cal_a', 'prj_sch_cal_b');

    const schedule = await data<Schedule>(await manager()('GET', '/prj_sch_cal'));
    expect(schedule.settings.holidays).toEqual(['2026-11-09']);
    expect(schedule.tasks.find((task) => task.id === 'prj_sch_cal_b')).toMatchObject({ earlyStart: '2026-11-10', shiftDays: 1 });
  });

  it('projects each deliverable to the end of its latest task', async () => {
    await seedChain('prj_sch_dlv');
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDeliverables).values({
      id: 'dlv_sch_1',
      projectId: 'prj_sch_dlv',
      number: 3,
      title: 'Order history',
      plannedStart: day('2026-11-02'),
      plannedEnd: day('2026-11-12'),
      createdBy: MANAGER,
      createdAt: now,
      updatedAt: now,
    });
    await db.update(schema.tasks).set({ deliverableId: 'dlv_sch_1' }).where(eq(schema.tasks.id, 'prj_sch_dlv_b'));
    await db.update(schema.tasks).set({ deliverableId: 'dlv_sch_1' }).where(eq(schema.tasks.id, 'prj_sch_dlv_c'));

    const schedule = await data<Schedule>(await manager()('GET', '/prj_sch_dlv'));
    expect(schedule.deliverables).toEqual([
      expect.objectContaining({ id: 'dlv_sch_1', code: 'D3', plannedEnd: '2026-11-12', projectedEnd: '2026-11-13', slipDays: 1 }),
    ]);
  });

  it('leaves deleted tasks out, and tasks of other projects', async () => {
    await seedChain('prj_sch_del');
    await seedChain('prj_sch_other');
    await db.update(schema.tasks).set({ deletedAt: new Date() }).where(eq(schema.tasks.id, 'prj_sch_del_x'));
    const schedule = await data<Schedule>(await manager()('GET', '/prj_sch_del'));
    expect(schedule.tasks.map((task) => task.id)).toEqual(['prj_sch_del_a', 'prj_sch_del_b', 'prj_sch_del_c']);
  });

  it('answers 404 for a project that does not exist, 403 to a non-member, and lets a viewer read', async () => {
    await seedChain('prj_sch_acl');
    expect((await manager()('GET', '/prj_sch_ghost')).status).toBe(404);
    const outsider = await as(OUTSIDER)('GET', '/prj_sch_acl');
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await as(VIEWER, ['projects:read'])('GET', '/prj_sch_acl')).status).toBe(200);
    expect((await as(MANAGER, [])('GET', '/prj_sch_acl')).status).toBe(403);
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe('GET and PUT /settings/:projectId', () => {
  it('reads the defaults and merge-writes only the schedule key', async () => {
    await seedProject('prj_sch_set', {
      settings: { sponsorId: 'user_sponsor', changeControl: { costLimit: 100, scheduleLimitDays: 2, boardMemberIds: ['user_b'] }, currentPhaseId: 'phs_x' },
    });
    const before = await manager()('GET', '/settings/prj_sch_set');
    expect(await data(before)).toEqual({ workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false });

    const res = await manager()('PUT', '/settings/prj_sch_set', { holidays: ['2026-12-25', '2026-12-24', '2026-12-25'], autoSchedule: true });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ workingDays: [1, 2, 3, 4, 5], holidays: ['2026-12-24', '2026-12-25'], autoSchedule: true });

    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_sch_set'));
    expect(project.settings).toEqual({
      sponsorId: 'user_sponsor',
      changeControl: { costLimit: 100, scheduleLimitDays: 2, boardMemberIds: ['user_b'] },
      currentPhaseId: 'phs_x',
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: ['2026-12-24', '2026-12-25'], autoSchedule: true },
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ entityType: 'project', action: 'updated', entityId: 'prj_sch_set', data: { id: 'prj_sch_set', name: 'prj_sch_set' } });

    // A second write changes only what it names.
    const again = await manager()('PUT', '/settings/prj_sch_set', { workingDays: [1, 2, 3, 4, 6, 6] });
    expect(await data(again)).toEqual({ workingDays: [1, 2, 3, 4, 6], holidays: ['2026-12-24', '2026-12-25'], autoSchedule: true });
    expect((await data<{ autoSchedule: boolean }>(await manager()('GET', '/settings/prj_sch_set'))).autoSchedule).toBe(true);
  });

  it('refuses a body with unknown fields, no working day, a bad weekday or a holiday that is not a date', async () => {
    await seedProject('prj_sch_set2');
    for (const body of [{ id: 'x' }, { workingDays: [] }, { workingDays: [0] }, { workingDays: [8] }, { autoSchedule: 'yes' }, { holidays: ['25-12-2026'] }]) {
      const res = await manager()('PUT', '/settings/prj_sch_set2', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const notReal = await manager()('PUT', '/settings/prj_sch_set2', { holidays: ['2026-02-30'] });
    expect(notReal.status).toBe(400);
    expect((await errorOf(notReal)).message).toBe('Holidays must be real dates in the form YYYY-MM-DD');
    expect(published).not.toHaveBeenCalled();
  });

  it('is for project managers: 404, 403 and the permission', async () => {
    await seedProject('prj_sch_set3');
    expect((await manager()('PUT', '/settings/prj_sch_ghost', { autoSchedule: true })).status).toBe(404);
    const member = await as(MEMBER)('PUT', '/settings/prj_sch_set3', { autoSchedule: true });
    expect(member.status).toBe(403);
    expect((await errorOf(member)).message).toBe('You do not have manage access to this project');
    expect((await as(VIEWER)('PUT', '/settings/prj_sch_set3', { autoSchedule: true })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PUT', '/settings/prj_sch_set3', { autoSchedule: true })).status).toBe(403);
    // Reading is for members.
    expect((await as(MEMBER, ['projects:read'])('GET', '/settings/prj_sch_set3')).status).toBe(200);
    expect((await as(OUTSIDER, ['projects:read'])('GET', '/settings/prj_sch_set3')).status).toBe(403);
    expect((await manager()('GET', '/settings/prj_sch_ghost')).status).toBe(404);
  });
});

// ── Preview ─────────────────────────────────────────────────────────────────

interface Impact {
  taskId: string;
  task: { startDate: string; dueDate: string };
  moved: Array<{ taskId: string; fromStart: string | null; toStart: string; toFinish: string; shiftDays: number }>;
  newConflicts: Array<{ linkId: string; successorId: string }>;
  before: { finish: string | null; goLiveSlackDays: number | null };
  after: { finish: string | null; goLiveSlackDays: number | null };
  deliverables: Array<{ id: string; code: string; endBefore: string | null; endAfter: string | null; shiftDays: number }>;
  goLive: { date: string | null };
  exceedsGoLive: boolean;
  finishShiftDays: number;
  autoSchedule: boolean;
  scheduleLimitDays: number;
  applied?: boolean;
}

describe('POST /:projectId/preview', () => {
  it('shows which dependents a move pushes, the effect on go-live and deliverables, and writes nothing', async () => {
    await seedChain('prj_sch_prev');
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projectDeliverables).values({
      id: 'dlv_sch_prev',
      projectId: 'prj_sch_prev',
      number: 3,
      title: 'Order history',
      plannedEnd: day('2026-11-13'),
      createdBy: MANAGER,
      createdAt: now,
      updatedAt: now,
    });
    await db.update(schema.tasks).set({ deliverableId: 'dlv_sch_prev' }).where(eq(schema.tasks.id, 'prj_sch_prev_c'));

    const res = await as(VIEWER, ['projects:read'])('POST', '/prj_sch_prev/preview', { taskId: 'prj_sch_prev_a', startDate: '2026-11-04' });
    expect(res.status).toBe(200);
    const impact = await data<Impact>(res);

    expect(impact.task).toEqual({ startDate: '2026-11-04', dueDate: '2026-11-10' });
    expect(impact.moved).toEqual([
      { taskId: 'prj_sch_prev_a', fromStart: '2026-11-02', fromFinish: '2026-11-06', toStart: '2026-11-04', toFinish: '2026-11-10', shiftDays: 2 },
      { taskId: 'prj_sch_prev_b', fromStart: '2026-11-09', fromFinish: '2026-11-10', toStart: '2026-11-11', toFinish: '2026-11-12', shiftDays: 2 },
      { taskId: 'prj_sch_prev_c', fromStart: '2026-11-11', fromFinish: '2026-11-13', toStart: '2026-11-13', toFinish: '2026-11-17', shiftDays: 2 },
    ]);
    expect(impact.newConflicts).toEqual([expect.objectContaining({ linkId: 'tdp_prj_sch_prev_1', successorId: 'prj_sch_prev_b' })]);
    expect(impact.before).toEqual({ finish: '2026-11-13', goLiveSlackDays: 5 });
    expect(impact.after).toEqual({ finish: '2026-11-17', goLiveSlackDays: 3 });
    expect(impact.finishShiftDays).toBe(2);
    expect(impact.exceedsGoLive).toBe(false);
    expect(impact.goLive.date).toBe('2026-11-20');
    expect(impact.deliverables).toEqual([
      { id: 'dlv_sch_prev', code: 'D3', title: 'Order history', plannedEnd: '2026-11-13', endBefore: '2026-11-13', endAfter: '2026-11-17', shiftDays: 2 },
    ]);
    expect(impact).toMatchObject({ autoSchedule: false, scheduleLimitDays: 5 });
    expect(impact.applied).toBeUndefined();

    // A preview is a read: the dates are as they were, and nothing is published.
    const [a] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'prj_sch_prev_a'));
    expect(a.startDate?.toISOString()).toBe('2026-11-02T09:30:00.000Z');
    expect(published).not.toHaveBeenCalled();
  });

  it('says when a move pushes the project finish past go-live', async () => {
    await seedChain('prj_sch_late');
    const impact = await data<Impact>(await manager()('POST', '/prj_sch_late/preview', { taskId: 'prj_sch_late_a', startDate: '2026-11-16' }));
    expect(impact.after.goLiveSlackDays).toBe(-5);
    expect(impact.exceedsGoLive).toBe(true);
    expect(impact.finishShiftDays).toBe(10);
  });

  it('leaves the dependents alone when they have room, and flags the conflict of a task dragged before its predecessor', async () => {
    await seedChain('prj_sch_room');
    const early = await data<Impact>(await manager()('POST', '/prj_sch_room/preview', { taskId: 'prj_sch_room_c', dueDate: '2026-11-12' }));
    expect(early.moved).toHaveLength(1);
    expect(early.moved[0]).toMatchObject({ taskId: 'prj_sch_room_c', shiftDays: -1 });
    expect(early.newConflicts).toEqual([expect.objectContaining({ linkId: 'tdp_prj_sch_room_2', successorId: 'prj_sch_room_c' })]);
    expect(early.task).toEqual({ startDate: '2026-11-10', dueDate: '2026-11-12' });
  });

  it('refuses in the fixed order: 404, 403, 400, then the rules', async () => {
    await seedChain('prj_sch_ref');
    await db.update(schema.tasks).set({ status: 'done' }).where(eq(schema.tasks.id, 'prj_sch_ref_x'));

    expect((await manager()('POST', '/prj_sch_ghost/preview', { taskId: 'x', startDate: '2026-11-09' })).status).toBe(404);
    expect((await as(OUTSIDER)('POST', '/prj_sch_ref/preview', { taskId: 'x', startDate: 'nope' })).status).toBe(403);
    for (const body of [{}, { taskId: 'prj_sch_ref_a', startDate: '9 Nov' }, { taskId: 'prj_sch_ref_a', startDate: '2026-11-09T00:00:00Z' }, { taskId: 'prj_sch_ref_a', startDate: '2026-11-09', extra: 1 }]) {
      const res = await manager()('POST', '/prj_sch_ref/preview', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const missing = await manager()('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_ref_a' });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Give a start date, a due date, or both');
    const reversed = await manager()('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_ref_a', startDate: '2026-11-09', dueDate: '2026-11-06' });
    expect((await errorOf(reversed)).message).toBe('The due date cannot be before the start date');
    const notReal = await manager()('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_ref_a', startDate: '2026-02-30' });
    expect((await errorOf(notReal)).message).toBe('Dates must be real dates in the form YYYY-MM-DD');
    const unknown = await manager()('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_nope', startDate: '2026-11-09' });
    expect(unknown.status).toBe(404);
    const done = await manager()('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_ref_x', startDate: '2026-11-09' });
    expect(done.status).toBe(409);
    expect((await errorOf(done)).message).toBe('A done or cancelled task cannot be moved');
    expect((await as(MANAGER, [])('POST', '/prj_sch_ref/preview', { taskId: 'prj_sch_ref_a', startDate: '2026-11-09' })).status).toBe(403);
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('POST /:projectId/apply', () => {
  it('moves the task and every dependent it pushes in one batch and publishes project_task.rescheduled for each', async () => {
    await seedChain('prj_sch_apply', { autoSchedule: true });

    const res = await as(MEMBER)('POST', '/prj_sch_apply/apply', { taskId: 'prj_sch_apply_a', startDate: '2026-11-04' });

    expect(res.status).toBe(200);
    const result = await data<Impact>(res);
    expect(result.applied).toBe(true);
    expect(result.moved.map((moved) => [moved.taskId, moved.toStart, moved.toFinish, moved.shiftDays])).toEqual([
      ['prj_sch_apply_a', '2026-11-04', '2026-11-10', 2],
      ['prj_sch_apply_b', '2026-11-11', '2026-11-12', 2],
      ['prj_sch_apply_c', '2026-11-13', '2026-11-17', 2],
    ]);
    expect(result.autoSchedule).toBe(true);

    // The dates are written with the time of day they had; the task nobody waits for did not move.
    const rows = new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, 'prj_sch_apply'))).map((row) => [row.id, row]));
    expect([rows.get('prj_sch_apply_a')?.startDate?.toISOString(), rows.get('prj_sch_apply_a')?.dueDate?.toISOString()]).toEqual(['2026-11-04T09:30:00.000Z', '2026-11-10T17:00:00.000Z']);
    expect([rows.get('prj_sch_apply_b')?.startDate?.toISOString(), rows.get('prj_sch_apply_b')?.dueDate?.toISOString()]).toEqual(['2026-11-11T09:30:00.000Z', '2026-11-12T17:00:00.000Z']);
    expect([rows.get('prj_sch_apply_c')?.startDate?.toISOString(), rows.get('prj_sch_apply_c')?.dueDate?.toISOString()]).toEqual(['2026-11-13T09:30:00.000Z', '2026-11-17T17:00:00.000Z']);
    expect(rows.get('prj_sch_apply_x')?.startDate?.toISOString()).toBe('2026-11-02T09:30:00.000Z');

    expect(events().map((event) => `${event.entityType}.${event.action}:${event.entityId}`)).toEqual([
      'project_task.rescheduled:prj_sch_apply_a',
      'project_task.rescheduled:prj_sch_apply_b',
      'project_task.rescheduled:prj_sch_apply_c',
    ]);
    expect(events()[1].data).toMatchObject({
      id: 'prj_sch_apply_b',
      projectId: 'prj_sch_apply',
      startDate: '2026-11-11T09:30:00.000Z',
      dueDate: '2026-11-12T17:00:00.000Z',
      previousStartDate: '2026-11-09T09:30:00.000Z',
      previousDueDate: '2026-11-10T17:00:00.000Z',
      shiftDays: 2,
      cause: 'dependency',
    });
    expect(events()[0].data).toMatchObject({ cause: 'moved', shiftDays: 2 });

    // What was written is now the schedule: nothing is left to push.
    const after = await data<Schedule>(await manager()('GET', '/prj_sch_apply'));
    expect(after.conflicts).toEqual([]);
    expect(after.finish).toBe('2026-11-17');
  });

  it('moves a task given only a due date, keeping its length', async () => {
    await seedChain('prj_sch_due', { autoSchedule: true });
    const res = await manager()('POST', '/prj_sch_due/apply', { taskId: 'prj_sch_due_x', dueDate: '2026-11-13' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'prj_sch_due_x'));
    expect([row.startDate?.toISOString(), row.dueDate?.toISOString()]).toEqual(['2026-11-12T09:30:00.000Z', '2026-11-13T17:00:00.000Z']);
  });

  it('is off until the project turns auto-schedule on', async () => {
    await seedChain('prj_sch_off');
    const res = await manager()('POST', '/prj_sch_off/apply', { taskId: 'prj_sch_off_a', startDate: '2026-11-04' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('Auto-schedule is off for this project');
    const [a] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'prj_sch_off_a'));
    expect(a.startDate?.toISOString()).toBe('2026-11-02T09:30:00.000Z');
    expect(published).not.toHaveBeenCalled();
  });

  it('refuses in the fixed order: 404, 403, 400, 409, then the rules', async () => {
    await seedChain('prj_sch_apref', { autoSchedule: true });
    await db.update(schema.tasks).set({ status: 'cancelled' }).where(eq(schema.tasks.id, 'prj_sch_apref_x'));
    const body = { taskId: 'prj_sch_apref_a', startDate: '2026-11-04' };

    expect((await manager()('POST', '/prj_sch_ghost/apply', body)).status).toBe(404);
    // A viewer can read the schedule but not move it.
    const viewer = await as(VIEWER)('POST', '/prj_sch_apref/apply', { nonsense: true });
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER)('POST', '/prj_sch_apref/apply', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '/prj_sch_apref/apply', body)).status).toBe(403);
    expect((await manager()('POST', '/prj_sch_apref/apply', { nonsense: true })).status).toBe(400);
    expect((await manager()('POST', '/prj_sch_apref/apply', { taskId: 'prj_sch_apref_a' })).status).toBe(400);
    expect((await manager()('POST', '/prj_sch_apref/apply', { taskId: 'prj_sch_nope', startDate: '2026-11-04' })).status).toBe(404);
    const closed = await manager()('POST', '/prj_sch_apref/apply', { taskId: 'prj_sch_apref_x', startDate: '2026-11-04' });
    expect(closed.status).toBe(409);
    expect(published).not.toHaveBeenCalled();
  });
});

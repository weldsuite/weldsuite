/**
 * DB-backed integration tests for the status reports: /api/project-status-reports.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json), so every status code, message and event
 * payload asserted here is the contract of both.
 *
 * The email and notification sends are mocked: they run after the response and
 * are tested on their own (lib/report-notifications.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { projectStatusReportsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

vi.mock('../../lib/report-notifications', () => ({
  sendPublishedReport: vi.fn(async () => ({ sent: 0, skipped: 0 })),
  notifyDraftReady: vi.fn(async () => true),
  sendPortalInvitation: vi.fn(async () => true),
}));

const MANAGER = 'user_rpt_manager';
const MEMBER = 'user_rpt_member';
const VIEWER = 'user_rpt_viewer';
const OUTSIDER = 'user_rpt_outsider';
const SCOPE_ALL = 'user_rpt_scope_all';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-status-reports', projectStatusReportsRoutes, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
  });
  return (method, path, body) =>
    request(`/api/project-status-reports${path}`, {
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
  return ((await res.json()) as { error: { code: string; message: string; details?: Array<{ path: string; message: string }> } }).error;
}

type Area = { key: string; colour: string; reason: string | null; auto: boolean; computed: { colour: string; code: string; params: Record<string, unknown> } | null };
type Item = { taskId: string | null; text: string; code: string | null; date: string | null };
type Report = {
  id: string;
  projectId: string;
  period: string;
  status: string;
  overall: string | null;
  areas: Area[];
  summary: string | null;
  done: Item[];
  next: Item[];
  clientVisible: boolean;
  supersedesId: string | null;
  supersededById: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  recipients: { stakeholderIds?: string[] } | null;
  resolvedRecipients: Array<{ stakeholderId: string | null; userId: string | null; name: string | null; email: string | null; kind: string }>;
  snapshot: Record<string, any> | null;
  createdBy: string;
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

/** The id a create answered, as the create's events carry it (Rust mints its own ids, with the same prefix). */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

const NOW = new Date('2026-11-04T10:12:00.000Z');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeEach(() => {
  published.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedProject(id: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: `Project ${id}`, projectManagerId: MANAGER, createdAt: now, updatedAt: now, ...extra });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function seedMember(userId: string, name: string, email: string | null = `${userId}@example.com`) {
  await db.insert(schema.workspaceMembers).values({ id: `wm_${userId}`, userId, name, email, role: 'MEMBER' }).onConflictDoNothing();
}

let stakeholderCounter = 0;
async function seedStakeholder(projectId: string, memberId: string, extra: Partial<typeof schema.projectStakeholders.$inferInsert> = {}) {
  stakeholderCounter += 1;
  const id = `stk_rpt_${stakeholderCounter}`;
  // Ascending creation times, so the register keeps the order they were added in.
  const createdAt = new Date(Date.UTC(2026, 10, 1, 8, 0, stakeholderCounter));
  await db.insert(schema.projectStakeholders).values({ id, projectId, memberId, createdBy: MANAGER, createdAt, updatedAt: createdAt, ...extra });
  return id;
}

async function createReport(projectId: string, body: Record<string, unknown> = {}, who: Send = manager()): Promise<Report> {
  const res = await who('POST', '', { projectId, ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Report>(res);
}

async function getReport(id: string): Promise<Report> {
  const res = await manager()('GET', `/${id}`);
  expect(res.status).toBe(200);
  return data<Report>(res);
}

async function patch(id: string, body: unknown, who: Send = manager()) {
  return who('PATCH', `/${id}`, body);
}

async function publish(id: string, who: Send = manager()) {
  return who('POST', `/${id}/publish`);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMember(MANAGER, 'Sanne Jansen');
  await seedMember(MEMBER, 'Daan Bakker');
}, 60_000);

// ── Settings ────────────────────────────────────────────────────────────────

describe('GET and PUT /settings/:projectId', () => {
  it('starts without a schedule, with the default risk appetite', async () => {
    await seedProject('prj_rs_default');
    const res = await manager()('GET', '/settings/prj_rs_default');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ projectId: 'prj_rs_default', statusReport: null, riskAppetite: 9, nextDraftAt: null });
  });

  it('saves the schedule and the appetite by merging into the settings, and publishes project.updated', async () => {
    await seedProject('prj_rs_put', { settings: { sponsorId: 'user_sponsor', changeControl: { costLimit: 1, scheduleLimitDays: 2, boardMemberIds: [] } } });
    const statusReport = { cadence: 'weekly', weekday: 1, hour: 9, recipients: { rule: 'sponsor' } };
    const res = await manager()('PUT', '/settings/prj_rs_put', { statusReport, riskAppetite: 12 });
    expect(res.status).toBe(200);
    const saved = await data<{ statusReport: unknown; riskAppetite: number; nextDraftAt: string }>(res);
    expect(saved.statusReport).toEqual(statusReport);
    expect(saved.riskAppetite).toBe(12);
    // A Monday at 00:00 UTC: the next slot day.
    expect(saved.nextDraftAt).toBe('2026-11-09T00:00:00.000Z');

    const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_rs_put'));
    expect(row?.settings).toEqual({
      sponsorId: 'user_sponsor',
      changeControl: { costLimit: 1, scheduleLimitDays: 2, boardMemberIds: [] },
      statusReport,
      riskAppetite: 12,
    });
    expect(actions()).toEqual(['project.updated']);
    expect(events()[0]).toMatchObject({ entityId: 'prj_rs_put', data: { id: 'prj_rs_put' } });
  });

  it('changes only the keys sent, and null turns the schedule off', async () => {
    await seedProject('prj_rs_off', { settings: { sponsorId: 'user_sponsor' } });
    await manager()('PUT', '/settings/prj_rs_off', { statusReport: { cadence: 'monthly', weekday: 1, hour: 8, recipients: { rule: 'all_stakeholders' } }, riskAppetite: 15 });
    const appetiteOnly = await manager()('PUT', '/settings/prj_rs_off', { riskAppetite: 6 });
    expect(await data(appetiteOnly)).toMatchObject({ statusReport: { cadence: 'monthly' }, riskAppetite: 6 });

    const off = await manager()('PUT', '/settings/prj_rs_off', { statusReport: null });
    expect(await data(off)).toEqual({ projectId: 'prj_rs_off', statusReport: null, riskAppetite: 6, nextDraftAt: null });
    const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, 'prj_rs_off'));
    expect(row?.settings).toEqual({ sponsorId: 'user_sponsor', riskAppetite: 6 });
  });

  it('publishes no event when nothing is written', async () => {
    await seedProject('prj_rs_noop');
    published.mockClear();
    const res = await manager()('PUT', '/settings/prj_rs_noop', {});
    expect(res.status).toBe(200);
    expect(actions()).toEqual([]);
  });

  it('validates the body', async () => {
    await seedProject('prj_rs_bad');
    const send = manager();
    const schedule = { cadence: 'weekly', weekday: 1, hour: 9, recipients: {} };
    for (const body of [
      { statusReport: { ...schedule, cadence: 'daily' } },
      { statusReport: { ...schedule, weekday: 8 } },
      { statusReport: { ...schedule, hour: 24 } },
      { statusReport: { ...schedule, recipients: { rule: 'everyone' } } },
      { riskAppetite: 0 },
      { riskAppetite: 26 },
      { other: 1 },
    ]) {
      const res = await send('PUT', '/settings/prj_rs_bad', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const unknownRecipient = await send('PUT', '/settings/prj_rs_bad', { statusReport: { ...schedule, recipients: { stakeholderIds: ['stk_nope'] } } });
    expect(unknownRecipient.status).toBe(400);
    expect((await errorOf(unknownRecipient)).message).toBe('Recipient not found in this project');
  });

  it('is for project managers to write and members to read', async () => {
    await seedProject('prj_rs_access');
    expect((await as(MEMBER)('GET', '/settings/prj_rs_access')).status).toBe(200);
    expect((await as(VIEWER)('GET', '/settings/prj_rs_access')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', '/settings/prj_rs_access')).status).toBe(403);
    const memberWrite = await as(MEMBER)('PUT', '/settings/prj_rs_access', { riskAppetite: 5 });
    expect(memberWrite.status).toBe(403);
    expect((await errorOf(memberWrite)).message).toBe('You do not have manage access to this project');
    expect((await as(OUTSIDER)('PUT', '/settings/prj_rs_access', { riskAppetite: 5 })).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PUT', '/settings/prj_rs_access', { riskAppetite: 5 })).status).toBe(403);
    const missing = await manager()('PUT', '/settings/prj_rs_missing', { riskAppetite: 5 });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Project with ID 'prj_rs_missing' not found");
    expect(published.mock.calls).toHaveLength(0);
  });
});

// ── Create: the data behind the colours ─────────────────────────────────────

describe('POST /', () => {
  it('drafts an empty project: no baseline, no finance and no benefits are grey, the rest green', async () => {
    await seedProject('prj_rc_empty');
    const report = await createReport('prj_rc_empty');
    expect(report).toMatchObject({
      projectId: 'prj_rc_empty',
      status: 'draft',
      overall: 'green',
      summary: null,
      done: [],
      next: [],
      clientVisible: false,
      supersedesId: null,
      supersededById: null,
      publishedBy: null,
      publishedAt: null,
      recipients: null,
      createdBy: MANAGER,
    });
    expect(report.period).toBe('2026-W45');
    expect(report.areas.map((area) => [area.key, area.colour, area.auto, area.reason])).toEqual([
      ['schedule', 'grey', true, null],
      ['budget', 'grey', true, null],
      ['scope', 'green', true, null],
      ['risk', 'green', true, null],
      ['benefits', 'grey', true, null],
    ]);
    expect(report.areas.map((area) => area.computed?.code)).toEqual([
      'schedule.no_baseline',
      'budget.no_data',
      'scope.none_pending',
      'risk.no_open_risks',
      'benefits.none',
    ]);
    expect(report.snapshot).toMatchObject({
      version: 1,
      asOf: NOW.toISOString(),
      baselineVersion: null,
      computed: { overall: 'green' },
      figures: { budget: null, pendingChanges: 0, riskAppetite: 9, openRisks: 0, highestRiskScore: null },
      topRisks: [],
      decisions: [],
      changes: [],
      milestones: [],
    });
    // The sponsor falls back to the project manager.
    expect(report.resolvedRecipients).toEqual([{ stakeholderId: null, userId: MANAGER, name: 'Sanne Jansen', email: `${MANAGER}@example.com`, kind: 'member' }]);
    expect(events()).toEqual([
      {
        entityType: 'project_status_report',
        action: 'created',
        entityId: minted(report.id),
        data: {
          id: minted(report.id),
          projectId: 'prj_rc_empty',
          period: '2026-W45',
          status: 'draft',
          overall: 'green',
          clientVisible: false,
          supersedesId: null,
          publishedAt: null,
        },
      },
    ]);
  });

  it('reads the plan, finance, changes, risks, benefits and decisions of the project', async () => {
    const id = 'prj_rc_data';
    await seedProject(id, { endDate: day('2027-01-22'), budgetCurrency: 'EUR', settings: { riskAppetite: 12 } });
    const goLiveBaseline = day('2027-01-15');
    await db.insert(schema.milestones).values([
      { id: 'ms_rc_beta', projectId: id, name: 'Beta for key accounts', dueDate: day('2026-12-01') },
      { id: 'ms_rc_done', projectId: id, name: 'Kick-off', dueDate: day('2026-10-01'), completedAt: day('2026-10-01'), status: 'completed' },
    ]);
    await db.insert(schema.projectDeliverables).values([
      { id: 'del_rc_2', projectId: id, number: 2, title: 'Catalogue and ordering', plannedEnd: day('2026-12-05'), createdBy: MANAGER },
      { id: 'del_rc_1', projectId: id, number: 1, title: 'Account and login', status: 'accepted', plannedEnd: day('2026-10-30'), acceptedAt: new Date('2026-11-02T09:00:00.000Z'), acceptedBy: MANAGER, createdBy: MANAGER },
    ]);
    await db.insert(schema.projectBaselines).values({
      id: 'bsl_rc_1',
      projectId: id,
      version: 3,
      createdBy: MANAGER,
      snapshot: {
        goLive: goLiveBaseline.toISOString(),
        milestones: [
          { id: 'ms_rc_beta', name: 'Beta for key accounts', dueDate: day('2026-12-01').toISOString() },
          { id: 'ms_rc_done', name: 'Kick-off', dueDate: day('2026-10-01').toISOString() },
        ],
        deliverables: [
          { id: 'del_rc_2', number: 2, title: 'Catalogue and ordering', plannedStart: null, plannedEnd: day('2026-11-28').toISOString() },
          { id: 'del_rc_1', number: 1, title: 'Account and login', plannedStart: null, plannedEnd: day('2026-10-30').toISOString() },
        ],
        budgetedAmount: '186400.00',
        budgetedHours: null,
        budgetCurrency: 'EUR',
        scopeStatement: null,
      },
    });
    await db.insert(schema.projectFinanceSnapshots).values([
      { id: 'fsn_rc_old', projectId: id, week: '2026-W43', budget: '186400.00', plannedValue: '90000.00', earnedValue: '60000.00', actualCost: '60000.00', committed: '0', forecast: '186400.00' },
      { id: 'fsn_rc_new', projectId: id, week: '2026-W44', budget: '186400.00', plannedValue: '110000.00', earnedValue: '98500.00', actualCost: '104800.00', committed: '0', forecast: '196900.00' },
    ]);
    await db.insert(schema.projectChangeRequests).values([
      { id: 'cr_rc_8', projectId: id, number: 8, title: 'Offer pay-in-3 terms', status: 'awaiting_approval', costDelta: '7500.00', scheduleDeltaDays: 6, createdBy: MANAGER },
      { id: 'cr_rc_7', projectId: id, number: 7, title: 'Order history for sub-accounts', status: 'assessing', createdBy: MANAGER },
      { id: 'cr_rc_6', projectId: id, number: 6, title: 'Dark mode', status: 'approved', createdBy: MANAGER },
    ]);
    const riskRow = (rid: string, number: number, title: string, probability: number, impact: number, extra: Record<string, unknown> = {}) => ({
      id: rid,
      projectId: id,
      kind: 'risk' as const,
      number,
      title,
      status: 'identified',
      probability,
      impact,
      createdBy: MANAGER,
      ...extra,
    });
    await db.insert(schema.projectRaidItems).values([
      riskRow('raid_rc_4', 4, 'Data migration loses historical order data', 5, 4, { ownerId: MEMBER }),
      riskRow('raid_rc_2', 2, 'Lead backend developer unavailable', 4, 4),
      riskRow('raid_rc_1', 1, 'Payment provider changes its API', 3, 5),
      riskRow('raid_rc_9', 9, 'Small thing', 1, 2),
      riskRow('raid_rc_closed', 7, 'Closed risk', 5, 5, { status: 'closed', closedAt: new Date('2026-10-20T00:00:00.000Z') }),
    ]);
    await db.insert(schema.projectRaidAssessments).values([
      { id: 'rasm_rc_a', itemId: 'raid_rc_2', projectId: id, probability: 3, impact: 4, assessedBy: MANAGER, assessedAt: new Date('2026-10-20T00:00:00.000Z') },
      { id: 'rasm_rc_b', itemId: 'raid_rc_2', projectId: id, probability: 4, impact: 4, assessedBy: MANAGER, assessedAt: new Date('2026-11-01T00:00:00.000Z') },
    ]);
    await db.insert(schema.projectBenefits).values({
      id: 'ben_rc_1',
      projectId: id,
      number: 1,
      title: 'Fewer order-status tickets',
      baselineValue: '100',
      targetValue: '200',
      realiseBy: new Date('2026-12-01T00:00:00.000Z'),
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      status: 'measuring',
      createdBy: MANAGER,
    });
    await db.insert(schema.projectBenefitMeasurements).values({ id: 'bnm_rc_1', benefitId: 'ben_rc_1', projectId: id, period: '2026-10', value: '150' });
    await db.insert(schema.projectDecisions).values({
      id: 'dec_rc_5',
      projectId: id,
      number: 5,
      title: 'Build checkout on payment API v3',
      status: 'proposed',
      deciderId: MEMBER,
      decisionDueAt: new Date('2026-11-06T00:00:00.000Z'),
      createdBy: MANAGER,
    });
    const { row: doneTask } = await createTask(db, { title: 'Sign in with Microsoft' }, { projectId: id, userId: MANAGER });
    await db.update(schema.tasks).set({ status: 'done', completedDate: new Date('2026-11-02T12:00:00.000Z') }).where(eq(schema.tasks.id, doneTask.id));
    const { row: dueTask } = await createTask(db, { title: 'Finish catalogue API' }, { projectId: id, userId: MANAGER });
    await db.update(schema.tasks).set({ dueDate: new Date('2026-11-06T00:00:00.000Z') }).where(eq(schema.tasks.id, dueTask.id));
    const { row: oldDone } = await createTask(db, { title: 'Long ago' }, { projectId: id, userId: MANAGER });
    await db.update(schema.tasks).set({ status: 'done', completedDate: new Date('2026-09-01T00:00:00.000Z') }).where(eq(schema.tasks.id, oldDone.id));

    const report = await createReport(id);
    const colours = Object.fromEntries(report.areas.map((area) => [area.key, [area.colour, area.computed?.code]]));
    expect(colours).toEqual({
      // D2 is 7 days and go-live 7 days late: amber.
      schedule: ['amber', 'schedule.behind'],
      // CPI 0.94, forecast 5.6% over the budget.
      budget: ['amber', 'budget.over'],
      // Two change requests are waiting.
      scope: ['amber', 'scope.pending'],
      // 20, 16 and 15 against an appetite of 12; the top one is critical.
      risk: ['red', 'risk.above_appetite'],
      // 50% progress, 56% expected by the clock.
      benefits: ['green', 'benefits.on_track'],
    });
    expect(report.overall).toBe('red');
    const computed = Object.fromEntries(report.areas.map((area) => [area.key, area.computed?.params]));
    expect(computed.schedule).toEqual({ baselineVersion: 3, worstDays: 7, worstName: 'D2 Catalogue and ordering', behindCount: 2, goLiveDays: 7 });
    expect(computed.budget).toMatchObject({ week: '2026-W44', cpi: 0.94, budget: '186400.00', forecast: '196900.00', currency: 'EUR' });
    expect(computed.risk).toEqual({ highest: 20, code: 'RSK-4', appetite: 12, aboveCount: 3 });

    const snapshot = report.snapshot as Record<string, any>;
    expect(snapshot.baselineVersion).toBe(3);
    expect(snapshot.currency).toBe('EUR');
    expect(snapshot.figures).toMatchObject({
      budget: { week: '2026-W44', cpi: 0.94, spi: 0.9, earnedValue: '98500.00' },
      pendingChanges: 2,
      riskAppetite: 12,
      openRisks: 4,
      highestRiskScore: 20,
    });
    expect(snapshot.topRisks).toEqual([
      { id: 'raid_rc_4', code: 'RSK-4', title: 'Data migration loses historical order data', score: 20, band: 'critical', ownerId: MEMBER, previousScore: null },
      { id: 'raid_rc_2', code: 'RSK-2', title: 'Lead backend developer unavailable', score: 16, band: 'high', ownerId: null, previousScore: 12 },
      { id: 'raid_rc_1', code: 'RSK-1', title: 'Payment provider changes its API', score: 15, band: 'high', ownerId: null, previousScore: null },
    ]);
    expect(snapshot.decisions).toEqual([
      { id: 'dec_rc_5', code: 'DEC-5', title: 'Build checkout on payment API v3', deciderId: MEMBER, dueAt: '2026-11-06T00:00:00.000Z' },
    ]);
    expect(snapshot.changes).toEqual([
      { id: 'cr_rc_7', code: 'CR-7', title: 'Order history for sub-accounts', status: 'assessing', costDelta: null, scheduleDeltaDays: null },
      { id: 'cr_rc_8', code: 'CR-8', title: 'Offer pay-in-3 terms', status: 'awaiting_approval', costDelta: '7500.00', scheduleDeltaDays: 6 },
    ]);
    // Open items against the baseline, earliest first; the finished ones are left out.
    expect(snapshot.milestones).toEqual([
      { kind: 'deliverable', id: 'del_rc_2', name: 'D2 Catalogue and ordering', baselineDate: '2026-11-28T00:00:00.000Z', forecastDate: '2026-12-05T00:00:00.000Z', varianceDays: 7 },
      { kind: 'milestone', id: 'ms_rc_beta', name: 'Beta for key accounts', baselineDate: '2026-12-01T00:00:00.000Z', forecastDate: '2026-12-01T00:00:00.000Z', varianceDays: 0 },
      { kind: 'go_live', id: null, name: 'Go-live', baselineDate: '2027-01-15T00:00:00.000Z', forecastDate: '2027-01-22T00:00:00.000Z', varianceDays: 7 },
    ]);
    // The week's done lines: the finished task and the accepted deliverable, newest first; nothing from September.
    expect(report.done.map((item) => [item.code, item.text, item.date])).toEqual([
      [`TASK-${doneTask.number}`, 'Sign in with Microsoft', '2026-11-02T12:00:00.000Z'],
      ['D1', 'Account and login', '2026-11-02T09:00:00.000Z'],
    ]);
    expect(report.done[0]?.taskId).toBe(doneTask.id);
    expect(report.done[1]?.taskId).toBeNull();
    // The next lines: tasks and decisions due in the coming week, soonest first (same date: by code).
    expect(report.next.map((item) => item.code)).toEqual(['DEC-5', `TASK-${dueTask.number}`].sort());
  });

  it('numbers nothing but names the period: an explicit week or month, or the next report of the cadence', async () => {
    await seedProject('prj_rc_period');
    const explicit = await createReport('prj_rc_period', { period: '2026-10' });
    expect(explicit.period).toBe('2026-10');
    await seedProject('prj_rc_cadence', { settings: { statusReport: { cadence: 'monthly', weekday: 1, hour: 9, recipients: {} } } });
    // The next slot is Tuesday 1 December: it reports on November.
    expect((await createReport('prj_rc_cadence')).period).toBe('2026-11');
  });

  it('takes the recipients of the schedule when it names stakeholders', async () => {
    await seedProject('prj_rc_recipients');
    await seedMember('user_rc_pk', 'Pieter Kok');
    const stakeholder = await seedStakeholder('prj_rc_recipients', 'user_rc_pk');
    await manager()('PUT', '/settings/prj_rc_recipients', { statusReport: { cadence: 'weekly', weekday: 1, hour: 9, recipients: { stakeholderIds: [stakeholder] } } });
    const report = await createReport('prj_rc_recipients');
    expect(report.recipients).toEqual({ stakeholderIds: [stakeholder] });
    expect(report.resolvedRecipients).toEqual([{ stakeholderId: stakeholder, userId: 'user_rc_pk', name: 'Pieter Kok', email: 'user_rc_pk@example.com', kind: 'member' }]);
  });

  it('refuses a second draft for a period, and a corrected one supersedes the published one', async () => {
    await seedProject('prj_rc_dup');
    const first = await createReport('prj_rc_dup');
    const duplicate = await manager()('POST', '', { projectId: 'prj_rc_dup' });
    expect(duplicate.status).toBe(409);
    expect((await errorOf(duplicate)).message).toBe('A draft already exists for this period');

    expect((await patch(first.id, { summary: 'On track.', clientVisible: true })).status).toBe(200);
    expect((await publish(first.id)).status).toBe(200);
    const correction = await createReport('prj_rc_dup');
    expect(correction.supersedesId).toBe(first.id);
    // Sharing with clients carries over to the correction.
    expect(correction.clientVisible).toBe(true);
    expect((await getReport(first.id)).supersededById).toBeNull();
    await patch(correction.id, { summary: 'Corrected.' });
    await publish(correction.id);
    expect((await getReport(first.id)).supersededById).toBe(correction.id);
    expect((await getReport(correction.id)).supersededById).toBeNull();
  });

  it('validates the body', async () => {
    await seedProject('prj_rc_bad');
    const send = manager();
    for (const body of [{}, { projectId: '' }, { projectId: 'prj_rc_bad', period: '2026-W54' }, { projectId: 'prj_rc_bad', period: '2026-13' }, { projectId: 'prj_rc_bad', extra: 1 }]) {
      const res = await send('POST', '', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const badPeriod = await errorOf(await send('POST', '', { projectId: 'prj_rc_bad', period: 'next week' }));
    expect(badPeriod.details).toEqual([{ path: 'period', message: 'period must be an ISO week (2026-W45) or a month (2026-11)' }]);
    const notJson = await createTestApp('/api/project-status-reports', projectStatusReportsRoutes, {
      context: { userId: MANAGER, permissions: permissions(...FULL), tenantDb: db },
    }).request('/api/project-status-reports', { method: 'POST', body: '{nope' });
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toBe('Invalid JSON body');
  });

  it('needs write permission and a manager of the project', async () => {
    await seedProject('prj_rc_access');
    for (const who of [as(MEMBER), as(VIEWER), as(OUTSIDER), as(MANAGER, ['projects:read'])]) {
      const res = await who('POST', '', { projectId: 'prj_rc_access' });
      expect(res.status).toBe(403);
    }
    expect((await errorOf(await as(MEMBER)('POST', '', { projectId: 'prj_rc_access' }))).message).toBe('You do not have manage access to this project');
    expect((await as(SCOPE_ALL)('POST', '', { projectId: 'prj_rc_access' })).status).toBe(201);
    const missing = await as(SCOPE_ALL)('POST', '', { projectId: 'prj_rc_missing' });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Project with ID 'prj_rc_missing' not found");
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('lists a project’s reports newest first, with the filter and a cursor', async () => {
    await seedProject('prj_rl_list');
    await seedProject('prj_rl_other');
    // The clock is frozen, so each report gets its own second.
    const at = (seconds: number) => vi.setSystemTime(new Date(NOW.getTime() + seconds * 1000));
    at(1);
    const a = await createReport('prj_rl_list', { period: '2026-W43' });
    at(2);
    await createReport('prj_rl_other', { period: '2026-W43' });
    at(3);
    const b = await createReport('prj_rl_list', { period: '2026-W44' });
    at(4);
    const c = await createReport('prj_rl_list', { period: '2026-W45' });
    await patch(a.id, { summary: 'Done.' });
    await publish(a.id);

    const all = await manager()('GET', '?projectId=prj_rl_list');
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Array<{ id: string; status: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((row) => row.id)).toEqual([c.id, b.id, a.id]);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    // The summary rows leave out the lists and the snapshot.
    expect(body.data[0]).not.toHaveProperty('snapshot');
    expect(body.data[0]).not.toHaveProperty('done');

    const first = (await (await manager()('GET', '?projectId=prj_rl_list&limit=2')).json()) as typeof body;
    expect(first.data.map((row) => row.id)).toEqual([c.id, b.id]);
    expect(first.pagination).toMatchObject({ totalCount: 3, hasMore: true, cursor: b.id });
    const second = (await (await manager()('GET', `?projectId=prj_rl_list&limit=2&cursor=${b.id}`)).json()) as typeof body;
    expect(second.data.map((row) => row.id)).toEqual([a.id]);
    expect(second.pagination.hasMore).toBe(false);

    const drafts = (await (await manager()('GET', '?projectId=prj_rl_list&status=draft')).json()) as typeof body;
    expect(drafts.data.map((row) => row.status)).toEqual(['draft', 'draft']);
  });

  it('answers 400 without a project or with a bad filter, and 403 outside the project', async () => {
    await seedProject('prj_rl_access');
    const missing = await manager()('GET', '');
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Invalid query parameters');
    expect((await manager()('GET', '?projectId=prj_rl_access&status=sent')).status).toBe(400);
    expect((await as(OUTSIDER)('GET', '?projectId=prj_rl_access')).status).toBe(403);
    expect((await as(VIEWER)('GET', '?projectId=prj_rl_access')).status).toBe(200);
    // `?projectId=` is no value at all.
    expect((await manager()('GET', '?projectId=')).status).toBe(400);
  });
});

describe('GET /:id', () => {
  it('answers 404 for an unknown report and 403 outside the project', async () => {
    await seedProject('prj_rg');
    const report = await createReport('prj_rg');
    const missing = await manager()('GET', '/rpt_nope');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Status report with ID 'rpt_nope' not found");
    expect((await as(OUTSIDER)('GET', `/${report.id}`)).status).toBe(403);
    expect((await as(VIEWER)('GET', `/${report.id}`)).status).toBe(200);
    expect((await as(MANAGER, [])('GET', `/${report.id}`)).status).toBe(403);
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('writes the summary, trimmed, and clears it with null', async () => {
    await seedProject('prj_rp_summary');
    const report = await createReport('prj_rp_summary');
    const res = await patch(report.id, { summary: '  The catalogue API is nearly done.  ' });
    expect(res.status).toBe(200);
    expect((await data<Report>(res)).summary).toBe('The catalogue API is nearly done.');
    expect((await data<Report>(await patch(report.id, { summary: null }))).summary).toBeNull();
    expect((await data<Report>(await patch(report.id, { summary: '   ' }))).summary).toBeNull();
    expect(actions()).toEqual(['project_status_report.created', 'project_status_report.updated', 'project_status_report.updated', 'project_status_report.updated']);
  });

  it('overrides an area with a reason, and goes back to the computed colour with null', async () => {
    await seedProject('prj_rp_area');
    const report = await createReport('prj_rp_area');
    const overridden = await data<Report>(
      await patch(report.id, { areas: [{ key: 'scope', override: { colour: 'red', reason: '  Three changes are stuck at the board.  ' } }] }),
    );
    const scope = overridden.areas.find((area) => area.key === 'scope');
    expect(scope).toEqual({
      key: 'scope',
      colour: 'red',
      reason: 'Three changes are stuck at the board.',
      auto: false,
      computed: { colour: 'green', code: 'scope.none_pending', params: {} },
    });
    // The other areas and the overall colour are untouched.
    expect(overridden.areas.filter((area) => area.auto)).toHaveLength(4);
    expect(overridden.overall).toBe('green');

    const reset = await data<Report>(await patch(report.id, { areas: [{ key: 'scope', override: null }] }));
    expect(reset.areas.find((area) => area.key === 'scope')).toMatchObject({ colour: 'green', reason: null, auto: true });
  });

  it('sets the overall colour, the lists, the client sharing and the recipients', async () => {
    await seedProject('prj_rp_all');
    await seedMember('user_rp_pk', 'Pieter Kok');
    const stakeholder = await seedStakeholder('prj_rp_all', 'user_rp_pk');
    const report = await createReport('prj_rp_all');
    const res = await patch(report.id, {
      overall: 'amber',
      done: [{ text: 'Spoke with the client', date: '2026-11-03T08:00:00Z' }, { taskId: 'task_x', text: 'Shipped', code: 'TASK-9', date: null }],
      next: [{ text: '  Plan the demo  ' }],
      clientVisible: true,
      recipients: { stakeholderIds: [stakeholder] },
    });
    expect(res.status).toBe(200);
    const updated = await data<Report>(res);
    expect(updated.overall).toBe('amber');
    expect(updated.done).toEqual([
      { taskId: null, text: 'Spoke with the client', code: null, date: '2026-11-03T08:00:00.000Z' },
      { taskId: 'task_x', text: 'Shipped', code: 'TASK-9', date: null },
    ]);
    expect(updated.next).toEqual([{ taskId: null, text: 'Plan the demo', code: null, date: null }]);
    expect(updated.clientVisible).toBe(true);
    expect(updated.recipients).toEqual({ stakeholderIds: [stakeholder] });
    expect(updated.resolvedRecipients.map((recipient) => recipient.name)).toEqual(['Pieter Kok']);

    const back = await data<Report>(await patch(report.id, { recipients: null }));
    expect(back.recipients).toBeNull();
    expect(events().map((event) => event.action)).toEqual(['created', 'updated', 'updated']);
    expect(events()[1]?.data).toMatchObject({ overall: 'amber', clientVisible: true });
  });

  it('answers the checks in order: 404, 403, 400, then the published report', async () => {
    await seedProject('prj_rp_order');
    const report = await createReport('prj_rp_order');
    const missing = await patch('rpt_nope', { summary: 'x' });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Status report with ID 'rpt_nope' not found");
    expect((await patch(report.id, { summary: 'x' }, as(MEMBER))).status).toBe(403);
    expect((await patch(report.id, { summary: 'x' }, as(OUTSIDER))).status).toBe(403);
    for (const body of [
      { summary: 5 },
      { overall: 'grey' },
      { areas: [{ key: 'scope', override: { colour: 'red', reason: '' } }] },
      { areas: [{ key: 'weather', override: null }] },
      { areas: [{ key: 'scope', override: { colour: 'grey', reason: 'x' } }] },
      { done: [{ text: '' }] },
      { done: 'none' },
      { clientVisible: 'yes' },
      { recipients: { stakeholderIds: [''] } },
      { extra: true },
    ]) {
      const res = await patch(report.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    const unknown = await patch(report.id, { recipients: { stakeholderIds: ['stk_nope'] } });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toBe('Recipient not found in this project');
  });
});

// ── Refresh ─────────────────────────────────────────────────────────────────

describe('POST /:id/refresh', () => {
  it('recomputes the data, keeps an override and the lines the project manager wrote', async () => {
    await seedProject('prj_rr');
    const report = await createReport('prj_rr');
    expect(report.areas.find((area) => area.key === 'scope')?.colour).toBe('green');
    await patch(report.id, {
      areas: [{ key: 'risk', override: { colour: 'amber', reason: 'Mitigation is under way' } }],
      done: [{ text: 'Called the client' }],
    });
    // New data since the draft: a pending change, a high risk above the appetite and a finished task.
    await db.insert(schema.projectChangeRequests).values({ id: 'cr_rr_1', projectId: 'prj_rr', number: 1, title: 'New thing', status: 'assessing', createdBy: MANAGER });
    await db.insert(schema.projectRaidItems).values({ id: 'raid_rr_1', projectId: 'prj_rr', kind: 'risk', number: 1, title: 'Big risk', status: 'identified', probability: 5, impact: 5, createdBy: MANAGER });
    const { row } = await createTask(db, { title: 'Finished today' }, { projectId: 'prj_rr', userId: MANAGER });
    await db.update(schema.tasks).set({ status: 'done', completedDate: new Date('2026-11-04T08:00:00.000Z') }).where(eq(schema.tasks.id, row.id));
    vi.setSystemTime(new Date('2026-11-04T15:30:00.000Z'));
    published.mockClear();

    const res = await manager()('POST', `/${report.id}/refresh`);
    expect(res.status).toBe(200);
    const refreshed = await data<Report>(res);
    expect(refreshed.areas.find((area) => area.key === 'scope')).toMatchObject({ colour: 'amber', auto: true });
    // The overridden area keeps the colour and the reason; the new computation is kept beside it.
    expect(refreshed.areas.find((area) => area.key === 'risk')).toMatchObject({
      colour: 'amber',
      reason: 'Mitigation is under way',
      auto: false,
      computed: { colour: 'red', code: 'risk.above_appetite' },
    });
    // The overall colour was the suggestion, so it follows the new suggestion.
    expect(refreshed.overall).toBe('red');
    expect(refreshed.snapshot?.asOf).toBe('2026-11-04T15:30:00.000Z');
    expect(refreshed.done.map((item) => item.text)).toEqual(['Finished today', 'Called the client']);
    expect(actions()).toEqual(['project_status_report.updated']);
  });

  it('keeps an overall colour the project manager set', async () => {
    await seedProject('prj_rr_overall');
    const report = await createReport('prj_rr_overall');
    await patch(report.id, { overall: 'amber' });
    await db.insert(schema.projectChangeRequests).values([1, 2, 3].map((n) => ({ id: `cr_rro_${n}`, projectId: 'prj_rr_overall', number: n, title: `Change ${n}`, status: 'assessing' as const, createdBy: MANAGER })));
    const refreshed = await data<Report>(await manager()('POST', `/${report.id}/refresh`));
    expect(refreshed.areas.find((area) => area.key === 'scope')?.colour).toBe('red');
    expect(refreshed.overall).toBe('amber');
    expect(refreshed.snapshot?.computed).toMatchObject({ overall: 'red' });
  });

  it('answers 404, 403 and 409 for a published report', async () => {
    await seedProject('prj_rr_checks');
    const report = await createReport('prj_rr_checks');
    expect((await manager()('POST', '/rpt_nope/refresh')).status).toBe(404);
    expect((await as(MEMBER)('POST', `/${report.id}/refresh`)).status).toBe(403);
    await patch(report.id, { summary: 'Fine.' });
    await publish(report.id);
    const res = await manager()('POST', `/${report.id}/refresh`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('A published report cannot be changed');
  });
});

// ── Publish ─────────────────────────────────────────────────────────────────

describe('POST /:id/publish', () => {
  it('freezes the report, sets the project health, and publishes the events', async () => {
    await seedProject('prj_rb', { health: 'on_track' });
    await db.insert(schema.projectChangeRequests).values([1, 2].map((n) => ({ id: `cr_rb_${n}`, projectId: 'prj_rb', number: n, title: `Change ${n}`, status: 'assessing' as const, createdBy: MANAGER })));
    const report = await createReport('prj_rb');
    expect(report.overall).toBe('amber');
    await patch(report.id, { summary: 'Two changes wait for an answer.', clientVisible: true, areas: [{ key: 'scope', override: { colour: 'green', reason: 'Both are small' } }] });
    published.mockClear();

    vi.setSystemTime(new Date('2026-11-04T16:00:00.000Z'));
    const res = await publish(report.id);
    expect(res.status).toBe(200);
    const done = await data<Report>(res);
    expect(done).toMatchObject({
      status: 'published',
      publishedBy: MANAGER,
      publishedAt: '2026-11-04T16:00:00.000Z',
      summary: 'Two changes wait for an answer.',
      overall: 'amber',
      clientVisible: true,
    });
    // What the sponsor was told, frozen into the snapshot with its figures.
    expect(done.snapshot).toMatchObject({
      version: 1,
      overall: 'amber',
      summary: 'Two changes wait for an answer.',
      figures: { pendingChanges: 2 },
      recipients: [{ stakeholderId: null, userId: MANAGER, name: 'Sanne Jansen', kind: 'member' }],
    });
    expect(done.snapshot?.areas).toEqual(report.areas.map((area) => (area.key === 'scope' ? { ...area, colour: 'green', reason: 'Both are small', auto: false } : area)).map(({ computed: _computed, ...area }) => area));
    // A published report names who it went to, never their addresses.
    expect(done.resolvedRecipients).toEqual([{ stakeholderId: null, userId: MANAGER, name: 'Sanne Jansen', email: null, kind: 'member' }]);

    const [project] = await db.select({ health: schema.projects.health }).from(schema.projects).where(eq(schema.projects.id, 'prj_rb'));
    expect(project?.health).toBe('at_risk');
    expect(actions()).toEqual(['project_status_report.published', 'project.updated']);
    expect(events()[0]).toEqual({
      entityType: 'project_status_report',
      action: 'published',
      entityId: minted(report.id),
      data: {
        id: minted(report.id),
        projectId: 'prj_rb',
        period: '2026-W45',
        status: 'published',
        overall: 'amber',
        clientVisible: true,
        supersedesId: null,
        publishedAt: '2026-11-04T16:00:00.000Z',
      },
    });
    expect(events()[1]?.data).toMatchObject({ id: 'prj_rb', health: 'at_risk' });
  });

  it('keeps showing the figures it was published with when the data moves on', async () => {
    await seedProject('prj_rb_frozen');
    const report = await createReport('prj_rb_frozen');
    await patch(report.id, { summary: 'All quiet.' });
    await publish(report.id);
    await db.insert(schema.projectChangeRequests).values({ id: 'cr_rbf_1', projectId: 'prj_rb_frozen', number: 1, title: 'Late change', status: 'assessing', createdBy: MANAGER });
    const again = await getReport(report.id);
    expect(again.snapshot?.figures).toMatchObject({ pendingChanges: 0 });
    expect(again.areas.find((area) => area.key === 'scope')?.colour).toBe('green');
  });

  it('is not an edit: a published report refuses every change', async () => {
    await seedProject('prj_rb_immutable');
    const report = await createReport('prj_rb_immutable');
    await patch(report.id, { summary: 'Done.' });
    await publish(report.id);
    const message = 'A published report cannot be changed';
    for (const [method, path, body] of [
      ['PATCH', `/${report.id}`, { summary: 'Changed' }],
      ['POST', `/${report.id}/refresh`, undefined],
      ['DELETE', `/${report.id}`, undefined],
    ] as const) {
      const res = await manager()(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect((await errorOf(res)).message).toBe(message);
    }
    const again = await publish(report.id);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This report is already published');
    expect((await getReport(report.id)).summary).toBe('Done.');
  });

  it('needs a summary and an overall colour', async () => {
    await seedProject('prj_rb_rules', { health: 'on_track' });
    const report = await createReport('prj_rb_rules');
    for (const summary of [undefined, null, '   ']) {
      if (summary !== undefined) await patch(report.id, { summary });
      const res = await publish(report.id);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe('Write a summary before publishing');
    }
    await patch(report.id, { summary: 'Fine.' });
    await db.update(schema.projectStatusReports).set({ overall: 'grey' }).where(eq(schema.projectStatusReports.id, report.id));
    const grey = await publish(report.id);
    expect(grey.status).toBe(400);
    expect((await errorOf(grey)).message).toBe('Set an overall status before publishing');
    await db.update(schema.projectStatusReports).set({ overall: null }).where(eq(schema.projectStatusReports.id, report.id));
    expect((await publish(report.id)).status).toBe(400);
    const [project] = await db.select({ health: schema.projects.health }).from(schema.projects).where(eq(schema.projects.id, 'prj_rb_rules'));
    expect(project?.health).toBe('on_track');
  });

  it('maps the colours onto the health the project list reads', async () => {
    await seedProject('prj_rb_health');
    const report = await createReport('prj_rb_health');
    await patch(report.id, { summary: 'Fine.', overall: 'red' });
    await publish(report.id);
    const [project] = await db.select({ health: schema.projects.health }).from(schema.projects).where(eq(schema.projects.id, 'prj_rb_health'));
    expect(project?.health).toBe('off_track');
  });

  it('answers 404 and 403', async () => {
    await seedProject('prj_rb_access');
    const report = await createReport('prj_rb_access');
    await patch(report.id, { summary: 'Fine.' });
    expect((await publish('rpt_nope')).status).toBe(404);
    expect((await publish(report.id, as(MEMBER))).status).toBe(403);
    expect((await publish(report.id, as(OUTSIDER))).status).toBe(403);
    expect((await publish(report.id, as(MANAGER, ['projects:read']))).status).toBe(403);
    expect((await getReport(report.id)).status).toBe('draft');
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('discards a draft: soft deleted, gone from reads, event published, not drafted again by the sweep', async () => {
    await seedProject('prj_rd');
    const report = await createReport('prj_rd');
    published.mockClear();
    const res = await manager()('DELETE', `/${report.id}`);
    expect(res.status).toBe(204);
    expect(actions()).toEqual(['project_status_report.deleted']);
    expect((await manager()('GET', `/${report.id}`)).status).toBe(404);
    const [row] = await db.select({ deletedAt: schema.projectStatusReports.deletedAt }).from(schema.projectStatusReports).where(eq(schema.projectStatusReports.id, report.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    // The period is free for a new draft.
    expect((await createReport('prj_rd')).id).not.toBe(report.id);
    const list = (await (await manager()('GET', '?projectId=prj_rd')).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(1);
  });

  it('answers 404, 403 and 409 for a published report', async () => {
    await seedProject('prj_rd_checks');
    const report = await createReport('prj_rd_checks');
    expect((await manager()('DELETE', '/rpt_nope')).status).toBe(404);
    expect((await as(MEMBER)('DELETE', `/${report.id}`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('DELETE', `/${report.id}`)).status).toBe(403);
    await patch(report.id, { summary: 'Fine.' });
    await publish(report.id);
    const res = await manager()('DELETE', `/${report.id}`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('A published report cannot be changed');
  });
});

describe('who a report goes to', () => {
  it('follows the rule of the schedule: the sponsor, every stakeholder, or the contacts with portal access', async () => {
    await seedProject('prj_rw', { settings: { sponsorId: 'user_rw_sponsor' } });
    await seedMember('user_rw_sponsor', 'Noor Hendriks');
    await seedMember('user_rw_pk', 'Pieter Kok');
    await db.insert(schema.people).values({ id: 'per_rw_1', displayName: 'Femke de Graaf', email: 'femke@example.com' });
    const member = await seedStakeholder('prj_rw', 'user_rw_pk');
    const contact = 'stk_rpt_contact';
    await db.insert(schema.projectStakeholders).values({ id: contact, projectId: 'prj_rw', crmContactId: 'per_rw_1', portalAccess: true, createdBy: MANAGER, createdAt: new Date('2026-11-02T08:00:00.000Z'), updatedAt: new Date('2026-11-02T08:00:00.000Z') });
    const names = async (rule: string) => {
      await manager()('PUT', '/settings/prj_rw', { statusReport: { cadence: 'weekly', weekday: 1, hour: 9, recipients: { rule } } });
      const report = await createReport('prj_rw', { period: `2026-W${rule === 'sponsor' ? 40 : rule === 'all_stakeholders' ? 41 : 42}` });
      return report.resolvedRecipients.map((recipient) => [recipient.stakeholderId, recipient.name, recipient.kind]);
    };
    expect(await names('sponsor')).toEqual([[null, 'Noor Hendriks', 'member']]);
    expect(await names('all_stakeholders')).toEqual([[member, 'Pieter Kok', 'member'], [contact, 'Femke de Graaf', 'contact']]);
    expect(await names('portal_contacts')).toEqual([[contact, 'Femke de Graaf', 'contact']]);
  });
});

describe('the data the project holds', () => {
  it('is only read by project, never across projects', async () => {
    await seedProject('prj_rx_a');
    await seedProject('prj_rx_b');
    await db.insert(schema.projectChangeRequests).values({ id: 'cr_rx_1', projectId: 'prj_rx_b', number: 1, title: 'Other project', status: 'assessing', createdBy: MANAGER });
    const report = await createReport('prj_rx_a');
    expect(report.areas.find((area) => area.key === 'scope')?.colour).toBe('green');
    const rows = await db.select({ id: schema.projectStatusReports.id }).from(schema.projectStatusReports).where(and(eq(schema.projectStatusReports.projectId, 'prj_rx_b')));
    expect(rows).toHaveLength(0);
  });
});

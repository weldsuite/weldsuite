/**
 * DB-backed integration tests for closing a project: /api/project-close (the
 * checklist, the hand-over and the sign-off request). Runs against the
 * TypeScript worker and, in conformance mode (rust/conformance/suites.json),
 * the Rust backend, so every status code, message and event payload asserted
 * here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval } from '@weldsuite/flow-domain/approvals';
import { projectCloseRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_cls_manager';
const SPONSOR = 'user_cls_sponsor';
const MEMBER = 'user_cls_member';
const VIEWER = 'user_cls_viewer';
const OUTSIDER = 'user_cls_outsider';
const SCOPE_ALL = 'user_cls_scope_all';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-close', projectCloseRoutes, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
  });
  return (method, path, body) =>
    request(`/api/project-close${path}`, {
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

interface Check {
  key: string;
  blocking: boolean;
  done: boolean;
  state: string;
  total: number;
  satisfied: number;
}

interface Checklist {
  projectId: string;
  projectName: string;
  status: string;
  closed: boolean;
  closedAt: string | null;
  checks: Check[];
  progress: { done: number; total: number };
  canRequest: boolean;
  deliverables: Array<{ id: string; code: string; title: string; status: string; acceptedAt: string | null }>;
  raidItems: Array<{ id: string; kind: string; code: string; title: string; status: string; ownerId: string | null; handedOver: boolean }>;
  benefits: Array<{
    id: string;
    code: string;
    title: string;
    status: string;
    ownerId: string | null;
    unit: string | null;
    baselineValue: string | null;
    targetValue: string | null;
    realiseBy: string | null;
    latest: { period: string; value: string; measuredAt: string } | null;
  }>;
  time: { total: number; approved: number; billed: number; open: number };
  finance: {
    currency: string | null;
    amountsVisible: boolean;
    budget: string | null;
    timeCost: string | null;
    snapshot: { week: string; actualCost: string; committed: string; forecast: string | null } | null;
    actual: string | null;
    variance: string | null;
    variancePercent: number | null;
    overBudget: boolean;
    baseline: { version: number; goLive: string | null } | null;
  };
  lessons: { total: number; published: number };
  signOff: {
    state: string;
    sponsorId: string | null;
    approval: { id: string; approverId: string; decision: string; note: string | null; decidedAt: string | null; decidedBy: string | null; delegatedFrom: string | null; requestedAt: string } | null;
  };
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

/** The id a create answered, as its events carry it: in conformance mode only the prefix is the same. */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeEach(() => {
  published.mockClear();
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const NOW = new Date('2027-02-20T08:00:00.000Z');

// ── Seeding ─────────────────────────────────────────────────────────────────

interface SeedOptions {
  status?: string;
  sponsor?: string | null;
  manager?: string | null;
  budgetedAmount?: string | null;
  settings?: Record<string, unknown>;
}

async function seedProject(id: string, options: SeedOptions = {}) {
  const sponsor = options.sponsor === undefined ? SPONSOR : options.sponsor;
  await db.insert(schema.projects).values({
    id,
    name: `Project ${id}`,
    status: options.status ?? 'Active',
    projectManagerId: options.manager === undefined ? MANAGER : options.manager,
    budgetCurrency: 'EUR',
    budgetedAmount: options.budgetedAmount === undefined ? '200000.00' : options.budgetedAmount,
    settings: { ...(sponsor ? { sponsorId: sponsor } : {}), ...(options.settings ?? {}) },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(schema.projectMembers).values(
    [
      [MEMBER, 'member'],
      [VIEWER, 'viewer'],
    ].map(([userId, role]) => ({ id: `pm_${id}_${userId}`, projectId: id, userId, role, isActive: true, createdAt: NOW, updatedAt: NOW, joinedAt: NOW })),
  );
}

let counter = 0;
const next = (prefix: string) => `${prefix}_cls_${(counter += 1)}`;

async function addDeliverable(projectId: string, number: number, status: 'not_started' | 'in_progress' | 'accepted' | 'rejected', acceptedAt: Date | null = null) {
  const id = next('dlv');
  await db.insert(schema.projectDeliverables).values({
    id,
    projectId,
    number,
    title: `Deliverable ${number}`,
    status,
    position: number,
    acceptedAt: status === 'accepted' ? (acceptedAt ?? NOW) : null,
    createdBy: MANAGER,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function addChange(projectId: string, number: number, status: string, deleted = false) {
  await db.insert(schema.projectChangeRequests).values({
    id: next('cr'),
    projectId,
    number,
    title: `Change ${number}`,
    status: status as 'draft',
    createdBy: MANAGER,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  });
}

async function addRaid(projectId: string, kind: 'risk' | 'issue' | 'assumption', number: number, options: { closed?: boolean; ownerId?: string | null; deleted?: boolean } = {}) {
  const id = next('raid');
  await db.insert(schema.projectRaidItems).values({
    id,
    projectId,
    kind,
    number,
    title: `${kind} ${number}`,
    status: kind === 'risk' ? (options.closed ? 'closed' : 'identified') : kind === 'issue' ? (options.closed ? 'resolved' : 'open') : options.closed ? 'validated' : 'open',
    ownerId: options.ownerId ?? null,
    probability: kind === 'risk' ? 3 : null,
    impact: kind === 'risk' ? 3 : null,
    closedAt: options.closed ? NOW : null,
    createdBy: MANAGER,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: options.deleted ? NOW : null,
  });
  return id;
}

async function addBenefit(
  projectId: string,
  number: number,
  options: { ownerId?: string | null; status?: 'planned' | 'measuring' | 'realised' | 'closed'; measurement?: string | null; deleted?: boolean } = {},
) {
  const id = next('ben');
  await db.insert(schema.projectBenefits).values({
    id,
    projectId,
    number,
    title: `Benefit ${number}`,
    ownerId: options.ownerId ?? null,
    status: options.status ?? 'measuring',
    unit: 'tickets',
    baselineValue: '1150.0000',
    targetValue: '400.0000',
    createdBy: MANAGER,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: options.deleted ? NOW : null,
  });
  if (options.measurement) {
    await db.insert(schema.projectBenefitMeasurements).values([
      { id: next('bm'), benefitId: id, projectId, period: '2027-01', value: '900.0000', measuredAt: new Date('2027-01-31T10:00:00.000Z'), createdAt: NOW },
      { id: next('bm'), benefitId: id, projectId, period: '2027-02', value: options.measurement, measuredAt: new Date('2027-02-19T10:00:00.000Z'), createdAt: NOW },
    ]);
  }
  return id;
}

async function addTime(projectId: string, status: string, cost: string | null, deleted = false) {
  await db.insert(schema.timeEntries).values({
    id: next('time'),
    projectId,
    userId: MEMBER,
    date: '2027-02-01',
    duration: '60',
    cost,
    status,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  });
}

async function addLesson(projectId: string, text: string, knowPageId: string | null = null, deleted = false) {
  await db.insert(schema.projectLessons).values({
    id: next('les'),
    projectId,
    category: 'went_well',
    text,
    authorId: MEMBER,
    votes: [],
    knowPageId,
    createdBy: MEMBER,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  });
}

/** A project that has done everything the checklist asks. */
async function seedReady(projectId: string, options: SeedOptions = {}) {
  await seedProject(projectId, options);
  await addDeliverable(projectId, 1, 'accepted');
  await addDeliverable(projectId, 2, 'accepted');
  await addChange(projectId, 1, 'approved');
  await addChange(projectId, 2, 'rejected');
  await addBenefit(projectId, 1, { ownerId: SPONSOR, measurement: '610.0000' });
  await addTime(projectId, 'approved', '100.00');
  await addTime(projectId, 'billed', '50.00');
  return projectId;
}

async function checklist(projectId: string, who: Send = manager()): Promise<Checklist> {
  const res = await who('GET', `/${projectId}`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return data<Checklist>(res);
}

const check = (list: Checklist, key: string) => list.checks.find((entry) => entry.key === key) as Check;

// ── The checklist ───────────────────────────────────────────────────────────

describe('GET /:projectId', () => {
  it('computes each check from the project tables', async () => {
    await seedProject('prj_cls_all');
    const accepted = new Date('2027-01-14T10:00:00.000Z');
    const d1 = await addDeliverable('prj_cls_all', 1, 'accepted', accepted);
    await addDeliverable('prj_cls_all', 2, 'in_progress');
    await addDeliverable('prj_cls_all', 3, 'accepted', accepted);
    // One live change request is still open; a deleted one and a decided one do not count.
    await addChange('prj_cls_all', 1, 'approved');
    await addChange('prj_cls_all', 2, 'awaiting_approval');
    await addChange('prj_cls_all', 3, 'draft', true);
    // Two open register items (one with an owner), a closed one and a deleted one do not.
    const risk = await addRaid('prj_cls_all', 'risk', 5, { ownerId: 'user_cls_owner' });
    const issue = await addRaid('prj_cls_all', 'issue', 4);
    await addRaid('prj_cls_all', 'issue', 1, { closed: true });
    await addRaid('prj_cls_all', 'assumption', 2, { deleted: true });
    // Benefits: one in order, one without a measurement, a closed one and a deleted one do not count.
    const b1 = await addBenefit('prj_cls_all', 1, { ownerId: SPONSOR, measurement: '610.0000' });
    await addBenefit('prj_cls_all', 2, { ownerId: SPONSOR });
    await addBenefit('prj_cls_all', 3, { status: 'closed' });
    await addBenefit('prj_cls_all', 4, { deleted: true });
    // Time: two approved, one billed, a draft, a submitted and a rejected entry; a deleted one does not count.
    await addTime('prj_cls_all', 'approved', '100.00');
    await addTime('prj_cls_all', 'approved', '50.50');
    await addTime('prj_cls_all', 'billed', '25.00');
    await addTime('prj_cls_all', 'draft', '999.00');
    await addTime('prj_cls_all', 'submitted', '999.00');
    await addTime('prj_cls_all', 'rejected', '999.00');
    await addTime('prj_cls_all', 'approved', '999.00', true);
    await addLesson('prj_cls_all', 'Published lesson', 'kpag_somewhere');
    await addLesson('prj_cls_all', 'Draft lesson');
    await addLesson('prj_cls_all', 'Deleted lesson', null, true);

    const list = await checklist('prj_cls_all');
    expect(list).toMatchObject({ projectId: 'prj_cls_all', projectName: 'Project prj_cls_all', status: 'Active', closed: false, closedAt: null, canRequest: false });
    expect(list.checks).toEqual([
      { key: 'deliverables', blocking: true, done: false, state: 'open', total: 3, satisfied: 2 },
      { key: 'changes', blocking: true, done: false, state: 'open', total: 2, satisfied: 1 },
      { key: 'raid', blocking: true, done: false, state: 'open', total: 2, satisfied: 0 },
      { key: 'benefits', blocking: true, done: false, state: 'open', total: 2, satisfied: 1 },
      { key: 'time', blocking: true, done: false, state: 'open', total: 6, satisfied: 3 },
      { key: 'lessons', blocking: false, done: false, state: 'open', total: 2, satisfied: 1 },
      { key: 'signoff', blocking: false, done: false, state: 'open', total: 0, satisfied: 0 },
    ]);
    expect(list.progress).toEqual({ done: 0, total: 7 });

    expect(list.deliverables.map((entry) => [entry.id, entry.code, entry.status, entry.acceptedAt])).toEqual([
      [d1, 'D1', 'accepted', accepted.toISOString()],
      [expect.any(String), 'D2', 'in_progress', null],
      [expect.any(String), 'D3', 'accepted', accepted.toISOString()],
    ]);
    // The register items in kind order, with their codes.
    expect(list.raidItems).toEqual([
      { id: risk, kind: 'risk', code: 'RSK-5', title: 'risk 5', status: 'identified', ownerId: 'user_cls_owner', handedOver: false },
      { id: issue, kind: 'issue', code: 'ISS-4', title: 'issue 4', status: 'open', ownerId: null, handedOver: false },
    ]);
    expect(list.benefits.map((entry) => [entry.id, entry.code, entry.ownerId, entry.latest?.period ?? null])).toEqual([
      [b1, 'B-1', SPONSOR, '2027-02'],
      [expect.any(String), 'B-2', SPONSOR, null],
    ]);
    expect(list.benefits[0]).toMatchObject({
      status: 'measuring',
      unit: 'tickets',
      baselineValue: '1150.0000',
      targetValue: '400.0000',
      realiseBy: null,
      latest: { period: '2027-02', value: '610.0000', measuredAt: '2027-02-19T10:00:00.000Z' },
    });
    expect(list.time).toEqual({ total: 6, approved: 2, billed: 1, open: 3 });
    expect(list.lessons).toEqual({ total: 2, published: 1 });
    expect(list.signOff).toEqual({ state: 'none', sponsorId: SPONSOR, approval: null });
  });

  it('is done, bar the sign-off, when everything is in order', async () => {
    await seedReady('prj_cls_ready');
    const list = await checklist('prj_cls_ready');
    expect(list.checks.map((entry) => [entry.key, entry.done])).toEqual([
      ['deliverables', true],
      ['changes', true],
      ['raid', true],
      ['benefits', true],
      ['time', true],
      ['lessons', false],
      ['signoff', false],
    ]);
    expect(list.canRequest).toBe(true);
    expect(list.progress).toEqual({ done: 5, total: 7 });
  });

  it('is done for a project with nothing to check, lessons aside', async () => {
    await seedProject('prj_cls_empty');
    const list = await checklist('prj_cls_empty');
    expect(list.checks.filter((entry) => entry.blocking).every((entry) => entry.done)).toBe(true);
    expect(check(list, 'lessons')).toMatchObject({ done: false, total: 0 });
    expect(list.canRequest).toBe(true);
    expect(list.finance).toMatchObject({ actual: '0.00', timeCost: '0.00' });
  });

  it('shows the final cost against the budget of the latest baseline, from the time entries', async () => {
    await seedProject('prj_cls_fin', { budgetedAmount: '1000.00' });
    await addTime('prj_cls_fin', 'approved', '1000.50');
    await addTime('prj_cls_fin', 'billed', '99.50');
    await addTime('prj_cls_fin', 'draft', '5000.00');
    await db.insert(schema.projectBaselines).values([
      { id: next('bl'), projectId: 'prj_cls_fin', version: 1, snapshot: { goLive: '2027-01-01T00:00:00.000Z', milestones: [], deliverables: [], budgetedAmount: '1000.00', budgetedHours: null, budgetCurrency: 'EUR', scopeStatement: null }, createdBy: MANAGER, createdAt: NOW },
      { id: next('bl'), projectId: 'prj_cls_fin', version: 4, snapshot: { goLive: '2027-01-15T00:00:00.000Z', milestones: [], deliverables: [], budgetedAmount: '1100.00', budgetedHours: null, budgetCurrency: 'EUR', scopeStatement: null }, createdBy: MANAGER, createdAt: NOW },
    ]);

    const list = await checklist('prj_cls_fin');
    expect(list.finance).toEqual({
      currency: 'EUR',
      amountsVisible: true,
      budget: '1100.00',
      timeCost: '1100.00',
      snapshot: null,
      actual: '1100.00',
      variance: '0.00',
      variancePercent: 0,
      overBudget: false,
      baseline: { version: 4, goLive: '2027-01-15T00:00:00.000Z' },
    });
  });

  it("prefers the latest finance snapshot's actual cost, and falls back to the project budget without a baseline", async () => {
    await seedProject('prj_cls_snap', { budgetedAmount: '193900.00' });
    await addTime('prj_cls_snap', 'approved', '120000.00');
    await db.insert(schema.projectFinanceSnapshots).values([
      { id: next('fsn'), projectId: 'prj_cls_snap', week: '2027-W07', actualCost: '180000.00', committed: '1000.00', forecast: null, createdAt: NOW },
      { id: next('fsn'), projectId: 'prj_cls_snap', week: '2027-W08', actualCost: '195200.00', committed: '0.00', forecast: '195200.00', createdAt: NOW },
    ]);
    const list = await checklist('prj_cls_snap');
    expect(list.finance).toEqual({
      currency: 'EUR',
      amountsVisible: true,
      budget: '193900.00',
      timeCost: '120000.00',
      snapshot: { week: '2027-W08', actualCost: '195200.00', committed: '0.00', forecast: '195200.00' },
      actual: '195200.00',
      variance: '1300.00',
      variancePercent: 0.7,
      overBudget: true,
      baseline: null,
    });
  });

  it('shows the percentage only to a member without finance access', async () => {
    await seedProject('prj_cls_hide', { budgetedAmount: '1000.00' });
    await addTime('prj_cls_hide', 'approved', '1100.00');
    const member = as(MEMBER, ['projects:read']);
    const hidden = (await checklist('prj_cls_hide', member)).finance;
    expect(hidden).toEqual({
      currency: 'EUR',
      amountsVisible: false,
      budget: null,
      timeCost: null,
      snapshot: null,
      actual: null,
      variance: null,
      variancePercent: 10,
      overBudget: true,
      baseline: null,
    });
    expect((await checklist('prj_cls_hide', as(MEMBER, ['projects:read', 'projects:finance']))).finance).toMatchObject({ amountsVisible: true, actual: '1100.00' });
    expect((await checklist('prj_cls_hide', manager())).finance.amountsVisible).toBe(true);
    expect((await checklist('prj_cls_hide', as(SCOPE_ALL))).finance.amountsVisible).toBe(true);
  });

  it('shows who is asked to sign off: the sponsor, else the project manager', async () => {
    await seedProject('prj_cls_sp1');
    await seedProject('prj_cls_sp2', { sponsor: null });
    await seedProject('prj_cls_sp3', { sponsor: null, manager: null });
    expect((await checklist('prj_cls_sp1')).signOff.sponsorId).toBe(SPONSOR);
    expect((await checklist('prj_cls_sp2')).signOff.sponsorId).toBe(MANAGER);
    expect((await checklist('prj_cls_sp3', as(SCOPE_ALL))).signOff.sponsorId).toBeNull();
  });

  it('answers a closed project as closed, with the day it closed', async () => {
    await seedProject('prj_cls_closed', { status: 'Closed' });
    await db.update(schema.projects).set({ actualEndDate: new Date('2027-02-26T00:00:00.000Z') }).where(eq(schema.projects.id, 'prj_cls_closed'));
    const list = await checklist('prj_cls_closed');
    expect(list).toMatchObject({ status: 'Closed', closed: true, closedAt: '2027-02-26T00:00:00.000Z', canRequest: false });
    expect(check(list, 'signoff')).toMatchObject({ done: true, state: 'done' });
  });

  it('refuses outsiders and a missing permission, and answers 404 for a missing project', async () => {
    await seedProject('prj_cls_access');
    const outsider = await as(OUTSIDER)('GET', '/prj_cls_access');
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    expect((await as(MANAGER, ['tasks:create'])('GET', '/prj_cls_access')).status).toBe(403);
    expect((await as(VIEWER, ['projects:read'])('GET', '/prj_cls_access')).status).toBe(200);
    const missing = await manager()('GET', '/prj_cls_nowhere');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Project with ID 'prj_cls_nowhere' not found");
  });
});

// ── Hand over ───────────────────────────────────────────────────────────────

describe('POST /:projectId/handover', () => {
  it('gives open register items and benefits a new owner, and records the hand-over', async () => {
    await seedProject('prj_cls_hand', { settings: { riskAppetite: 12, schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false } } });
    const risk = await addRaid('prj_cls_hand', 'risk', 5, { ownerId: MANAGER });
    const issue = await addRaid('prj_cls_hand', 'issue', 4);
    const benefit = await addBenefit('prj_cls_hand', 1, { ownerId: MANAGER });
    published.mockClear();

    const res = await manager()('POST', '/prj_cls_hand/handover', {
      raidItems: [
        { id: risk, ownerId: 'user_cls_support' },
        { id: issue, ownerId: 'user_cls_backlog' },
      ],
      benefits: [{ id: benefit, ownerId: SPONSOR }],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const list = await data<Checklist>(res);
    expect(list.raidItems).toEqual([
      { id: risk, kind: 'risk', code: 'RSK-5', title: 'risk 5', status: 'identified', ownerId: 'user_cls_support', handedOver: true },
      { id: issue, kind: 'issue', code: 'ISS-4', title: 'issue 4', status: 'open', ownerId: 'user_cls_backlog', handedOver: true },
    ]);
    expect(check(list, 'raid')).toMatchObject({ done: true, total: 2, satisfied: 2 });
    expect(list.benefits[0]).toMatchObject({ id: benefit, ownerId: SPONSOR });

    // The settings keep their other keys; only `closing` is written.
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_cls_hand'));
    expect(project?.settings).toEqual({
      sponsorId: SPONSOR,
      riskAppetite: 12,
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false },
      closing: {
        handovers: {
          [risk]: { ownerId: 'user_cls_support', by: MANAGER, at: expect.any(String) },
          [issue]: { ownerId: 'user_cls_backlog', by: MANAGER, at: expect.any(String) },
        },
      },
    });

    // The events follow the request: the items, the benefit, then the project.
    expect(actions()).toEqual(['project_raid_item.updated', 'project_raid_item.updated', 'project_benefit.updated', 'project.updated']);
    expect(events()[0]).toMatchObject({
      entityId: risk,
      data: { id: risk, projectId: 'prj_cls_hand', kind: 'risk', code: 'RSK-5', status: 'identified', ownerId: 'user_cls_support', score: 9, band: 'medium' },
    });
    expect(events()[2]).toEqual({
      entityType: 'project_benefit',
      action: 'updated',
      entityId: benefit,
      data: { id: benefit, projectId: 'prj_cls_hand', number: 1, code: 'B-1', title: 'Benefit 1', status: 'measuring', ownerId: SPONSOR },
    });
    expect(events()[3]).toMatchObject({ entityType: 'project', entityId: 'prj_cls_hand', data: { id: 'prj_cls_hand', name: 'Project prj_cls_hand' } });
  });

  it('adds to the earlier hand-overs, and the last owner named for an item wins', async () => {
    await seedProject('prj_cls_hand2');
    const first = await addRaid('prj_cls_hand2', 'risk', 1);
    const second = await addRaid('prj_cls_hand2', 'issue', 1);
    await manager()('POST', '/prj_cls_hand2/handover', { raidItems: [{ id: first, ownerId: 'user_cls_a' }] });
    const res = await manager()('POST', '/prj_cls_hand2/handover', {
      raidItems: [
        { id: second, ownerId: 'user_cls_b' },
        { id: second, ownerId: 'user_cls_c' },
      ],
    });
    const list = await data<Checklist>(res);
    expect(list.raidItems.map((item) => [item.id, item.ownerId, item.handedOver])).toEqual([
      [first, 'user_cls_a', true],
      [second, 'user_cls_c', true],
    ]);
  });

  it('publishes nothing for an owner that stays the same', async () => {
    await seedProject('prj_cls_hand3');
    const risk = await addRaid('prj_cls_hand3', 'risk', 1, { ownerId: 'user_cls_same' });
    published.mockClear();
    const res = await manager()('POST', '/prj_cls_hand3/handover', { raidItems: [{ id: risk, ownerId: 'user_cls_same' }] });
    expect(res.status).toBe(200);
    expect((await data<Checklist>(res)).raidItems[0]).toMatchObject({ handedOver: true });
    // The hand-over is recorded, so the project's settings changed.
    expect(actions()).toEqual(['project.updated']);
  });

  it('hands over benefits alone without touching the settings', async () => {
    await seedProject('prj_cls_hand4');
    const benefit = await addBenefit('prj_cls_hand4', 1);
    published.mockClear();
    const res = await manager()('POST', '/prj_cls_hand4/handover', { benefits: [{ id: benefit, ownerId: SPONSOR }] });
    expect(res.status).toBe(200);
    expect(actions()).toEqual(['project_benefit.updated']);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_cls_hand4'));
    expect(project?.settings).toEqual({ sponsorId: SPONSOR });
  });

  it('refuses items that are not open items or benefits of this project', async () => {
    await seedProject('prj_cls_hand5');
    await seedProject('prj_cls_hand5b');
    const closed = await addRaid('prj_cls_hand5', 'issue', 1, { closed: true });
    const deleted = await addRaid('prj_cls_hand5', 'issue', 2, { deleted: true });
    const other = await addRaid('prj_cls_hand5b', 'issue', 1);
    const open = await addRaid('prj_cls_hand5', 'issue', 3);
    const closedBenefit = await addBenefit('prj_cls_hand5', 1, { status: 'closed' });
    const otherBenefit = await addBenefit('prj_cls_hand5b', 1);
    published.mockClear();

    for (const id of [closed, deleted, other, 'raid_nowhere']) {
      const res = await manager()('POST', '/prj_cls_hand5/handover', { raidItems: [{ id: open, ownerId: 'user_cls_a' }, { id, ownerId: 'user_cls_a' }] });
      expect(res.status, id).toBe(400);
      expect((await errorOf(res)).message).toBe('RAID item not found, or no longer open, in this project');
    }
    for (const id of [closedBenefit, otherBenefit]) {
      const res = await manager()('POST', '/prj_cls_hand5/handover', { benefits: [{ id, ownerId: 'user_cls_a' }] });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe('Benefit not found, or already closed, in this project');
    }
    // Nothing was written by the refused requests.
    expect(actions()).toEqual([]);
    const [row] = await db.select().from(schema.projectRaidItems).where(eq(schema.projectRaidItems.id, open));
    expect(row?.ownerId).toBeNull();
  });

  it('refuses an empty hand-over and a body that does not fit', async () => {
    await seedProject('prj_cls_hand6');
    const empty = await manager()('POST', '/prj_cls_hand6/handover', {});
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Choose at least one item to hand over');
    expect((await manager()('POST', '/prj_cls_hand6/handover', { raidItems: [], benefits: [] })).status).toBe(400);

    for (const body of [{ raidItems: [{ id: 'x' }] }, { raidItems: [{ id: 'x', ownerId: '' }] }, { raidItems: 'x' }, { other: [] }, 'not an object']) {
      const res = await manager()('POST', '/prj_cls_hand6/handover', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
  });

  it('is for project managers: members, viewers and outsiders are refused, and so is a missing permission', async () => {
    await seedProject('prj_cls_hand7');
    const risk = await addRaid('prj_cls_hand7', 'risk', 1);
    const body = { raidItems: [{ id: risk, ownerId: 'user_cls_a' }] };
    const member = await as(MEMBER, FULL)('POST', '/prj_cls_hand7/handover', body);
    expect(member.status).toBe(403);
    expect((await errorOf(member)).message).toBe('You must be a project owner, admin, or manager to close this project');
    expect((await as(VIEWER, FULL)('POST', '/prj_cls_hand7/handover', body)).status).toBe(403);
    expect((await as(OUTSIDER, FULL)('POST', '/prj_cls_hand7/handover', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '/prj_cls_hand7/handover', body)).status).toBe(403);
    expect((await as(SCOPE_ALL)('POST', '/prj_cls_hand7/handover', body)).status).toBe(200);
    const missing = await manager()('POST', '/prj_cls_nowhere/handover', body);
    expect(missing.status).toBe(404);
  });
});

// ── Request sign-off ────────────────────────────────────────────────────────

async function approvalsOf(projectId: string) {
  return db
    .select()
    .from(schema.flowApprovals)
    .where(and(eq(schema.flowApprovals.subjectType, 'project_close'), eq(schema.flowApprovals.subjectId, projectId), isNull(schema.flowApprovals.deletedAt)));
}

describe('POST /:projectId/request', () => {
  it('asks the sponsor, with the rule close, once the checklist is in order', async () => {
    await seedReady('prj_cls_req');
    const res = await manager()('POST', '/prj_cls_req/request', {});
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const list = await data<Checklist>(res);
    expect(list.signOff).toMatchObject({
      state: 'pending',
      sponsorId: SPONSOR,
      approval: { approverId: SPONSOR, decision: 'pending', note: null, decidedAt: null, decidedBy: null, delegatedFrom: null },
    });
    expect(check(list, 'signoff')).toMatchObject({ done: false, state: 'waiting' });
    expect(list.canRequest).toBe(false);
    expect(list.status).toBe('Active');

    const [row] = await approvalsOf('prj_cls_req');
    expect(row).toMatchObject({
      projectId: 'prj_cls_req',
      subjectType: 'project_close',
      subjectId: 'prj_cls_req',
      approverKind: 'member',
      approverId: SPONSOR,
      roleLabel: 'Sponsor',
      step: 1,
      rule: { code: 'close' },
      decision: 'pending',
      createdBy: MANAGER,
    });
    expect(events()).toEqual([
      {
        entityType: 'flow_approval',
        action: 'requested',
        entityId: minted(row!.id),
        data: {
          id: minted(row!.id),
          projectId: 'prj_cls_req',
          subjectType: 'project_close',
          subjectId: 'prj_cls_req',
          approverKind: 'member',
          approverId: SPONSOR,
          step: 1,
          delegatedFrom: null,
          decision: 'pending',
          dueAt: null,
        },
      },
    ]);
  });

  it('asks the project manager when the project has no sponsor', async () => {
    await seedReady('prj_cls_req2', { sponsor: null });
    const res = await manager()('POST', '/prj_cls_req2/request', {});
    expect(res.status).toBe(201);
    expect((await approvalsOf('prj_cls_req2')).map((row) => row.approverId)).toEqual([MANAGER]);
  });

  it('refuses while a blocking check is open, and says nothing was asked', async () => {
    await seedReady('prj_cls_req3');
    await addDeliverable('prj_cls_req3', 3, 'in_progress');
    const res = await manager()('POST', '/prj_cls_req3/request', {});
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('Finish the open checks before asking for sign-off');
    expect(await approvalsOf('prj_cls_req3')).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it('does not block on the advisory checks', async () => {
    await seedReady('prj_cls_req4');
    await addLesson('prj_cls_req4', 'Not published yet');
    expect((await manager()('POST', '/prj_cls_req4/request', { note: 'All done' })).status).toBe(201);
  });

  it('refuses a second request while one is waiting, and a closed project', async () => {
    await seedReady('prj_cls_req5');
    expect((await manager()('POST', '/prj_cls_req5/request', {})).status).toBe(201);
    const again = await manager()('POST', '/prj_cls_req5/request', {});
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Sign-off has already been requested');
    expect(await approvalsOf('prj_cls_req5')).toHaveLength(1);

    await seedReady('prj_cls_req5b', { status: 'Closed' });
    const closed = await manager()('POST', '/prj_cls_req5b/request', {});
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).message).toBe('This project is already closed');
  });

  it('needs somebody to ask', async () => {
    await seedReady('prj_cls_req6', { sponsor: null, manager: null });
    const res = await as(SCOPE_ALL)('POST', '/prj_cls_req6/request', {});
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('The project has no sponsor or project manager to ask for sign-off');
  });

  it('starts over after the sponsor declined', async () => {
    await seedReady('prj_cls_req7');
    await manager()('POST', '/prj_cls_req7/request', {});
    const [first] = await approvalsOf('prj_cls_req7');
    const declined = await decideApproval(db, { approvalId: first!.id, actor: SPONSOR, decision: 'rejected', note: 'Benefits are not measured yet' });
    expect(declined).toMatchObject({ ok: true, outcome: 'rejected' });

    const afterDecline = await checklist('prj_cls_req7');
    expect(afterDecline.status).toBe('Active');
    expect(afterDecline.signOff).toMatchObject({ state: 'rejected', approval: { decision: 'rejected', note: 'Benefits are not measured yet', decidedBy: SPONSOR } });
    expect(afterDecline.canRequest).toBe(true);

    published.mockClear();
    const again = await manager()('POST', '/prj_cls_req7/request', {});
    expect(again.status).toBe(201);
    expect((await data<Checklist>(again)).signOff).toMatchObject({ state: 'pending', approval: { decision: 'pending', note: null } });
    const live = await approvalsOf('prj_cls_req7');
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(first!.id);
    expect(actions()).toEqual(['flow_approval.cancelled', 'flow_approval.requested']);
  });

  it('is for project managers: members, viewers and outsiders are refused, and so is a missing permission', async () => {
    await seedReady('prj_cls_req8');
    const member = await as(MEMBER, FULL)('POST', '/prj_cls_req8/request', {});
    expect(member.status).toBe(403);
    expect((await errorOf(member)).message).toBe('You must be a project owner, admin, or manager to close this project');
    expect((await as(VIEWER, FULL)('POST', '/prj_cls_req8/request', {})).status).toBe(403);
    expect((await as(OUTSIDER, FULL)('POST', '/prj_cls_req8/request', {})).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '/prj_cls_req8/request', {})).status).toBe(403);
    expect((await manager()('POST', '/prj_cls_nowhere/request', {})).status).toBe(404);
    expect(await approvalsOf('prj_cls_req8')).toEqual([]);
  });

  it('refuses a body that does not fit', async () => {
    await seedReady('prj_cls_req9');
    for (const body of [{ note: 'x'.repeat(2001) }, { extra: true }, 'not an object']) {
      const res = await manager()('POST', '/prj_cls_req9/request', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect(await approvalsOf('prj_cls_req9')).toEqual([]);
  });
});

// ── Sign-off closes the project ─────────────────────────────────────────────

describe('the sponsor signs off', () => {
  it("sets the project to Closed with its end date, and the checklist shows it", async () => {
    await seedReady('prj_cls_sign');
    await manager()('POST', '/prj_cls_sign/request', {});
    const [row] = await approvalsOf('prj_cls_sign');

    const answered = await decideApproval(db, { approvalId: row!.id, actor: SPONSOR, decision: 'approved', now: new Date('2027-02-26T09:30:00.000Z') });
    expect(answered).toMatchObject({ ok: true, outcome: 'approved', resolved: true });

    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_cls_sign'));
    expect(project?.status).toBe('Closed');
    expect(project?.actualEndDate?.toISOString()).toBe('2027-02-26T09:30:00.000Z');

    const list = await checklist('prj_cls_sign');
    expect(list).toMatchObject({ status: 'Closed', closed: true, closedAt: '2027-02-26T09:30:00.000Z', canRequest: false });
    expect(list.signOff).toMatchObject({ state: 'approved', approval: { decision: 'approved', decidedBy: SPONSOR } });
    expect(check(list, 'signoff')).toMatchObject({ done: true, state: 'done' });
  });

  it('keeps an end date the project already has', async () => {
    await seedReady('prj_cls_sign2');
    await db.update(schema.projects).set({ actualEndDate: new Date('2027-02-10T00:00:00.000Z') }).where(eq(schema.projects.id, 'prj_cls_sign2'));
    await manager()('POST', '/prj_cls_sign2/request', {});
    const [row] = await approvalsOf('prj_cls_sign2');
    await decideApproval(db, { approvalId: row!.id, actor: SPONSOR, decision: 'approved' });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_cls_sign2'));
    expect(project?.status).toBe('Closed');
    expect(project?.actualEndDate?.toISOString()).toBe('2027-02-10T00:00:00.000Z');
  });

  it('leaves the project open when the sponsor declines', async () => {
    await seedReady('prj_cls_sign3');
    await manager()('POST', '/prj_cls_sign3/request', {});
    const [row] = await approvalsOf('prj_cls_sign3');
    await decideApproval(db, { approvalId: row!.id, actor: SPONSOR, decision: 'rejected', note: 'Not yet' });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_cls_sign3'));
    expect(project?.status).toBe('Active');
  });
});

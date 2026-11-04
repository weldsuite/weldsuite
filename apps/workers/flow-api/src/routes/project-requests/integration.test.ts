/**
 * DB-backed integration tests for project intake: /api/project-requests
 * (requests, scoring, submit to the portfolio board, convert, roadmap, funnel
 * and the workspace settings). Runs against the TypeScript worker and, in
 * conformance mode, the Rust backend (rust/conformance/suites.json), so every
 * status code, message and event payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval } from '@weldsuite/flow-domain/approvals';
import { projectRequestsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const ADMIN = 'user_pr_admin';
const BOARD1 = 'user_pr_board1';
const BOARD2 = 'user_pr_board2';
const REQUESTER = 'user_pr_requester';
const OTHER = 'user_pr_other';
const PM = 'user_pr_pm';
const OUTSIDER = 'user_pr_outsider';

const KEYS: Record<string, string[]> = {
  [ADMIN]: ['portfolio:read', 'portfolio:manage', 'projects:read'],
  [BOARD1]: ['portfolio:read'],
  [BOARD2]: ['portfolio:read'],
  [REQUESTER]: ['portfolio:read'],
  [OTHER]: ['portfolio:read'],
  [PM]: ['portfolio:read', 'projects:read', 'projects:update'],
  [OUTSIDER]: ['projects:read'],
};

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string): Send {
  const { request } = createTestApp('/api/project-requests', projectRequestsRoutes, {
    context: { userId, permissions: permissions(...(KEYS[userId] ?? [])), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-requests${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

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

/** In conformance mode the spy records the TypeScript run (rolled back) and the answer is Rust's: only the prefix of a minted id is the same. */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

type Request = {
  id: string;
  number: number;
  code: string;
  title: string;
  requestedBy: string;
  businessCase: string | null;
  estimatedCost: string | null;
  estimatedValue: string | null;
  scores: Record<string, number>;
  score: number | null;
  neededSkills: Array<{ skill: string; hoursPerWeek?: number }>;
  desiredStart: string | null;
  desiredEnd: string | null;
  status: string;
  submittedAt: string | null;
  projectId: string | null;
};
type Detail = Request & {
  breakdown: Array<{ key: string; value: number | null; points: number | null; weight: number }>;
  approvals: Array<{ approverId: string; decision: string; roleLabel: string | null; step: number; note: string | null }>;
  fit: Array<{ skill: string; needHoursPerWeek: number | null; freeHoursPerWeek: number; shortWeeks: number; weeks: number; short: boolean }>;
  fitWindow: { from: string; to: string };
};

const SCORES = { value: 5, fit: 5, urgency: 4, risk: 3, effort: 4 };

async function create(extra: Record<string, unknown> = {}, who: Send = as(REQUESTER)): Promise<Request> {
  const res = await who('POST', '', { title: 'Supplier portal', ...extra });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Request>(res);
}

async function detail(id: string, who: Send = as(ADMIN)): Promise<Detail> {
  const res = await who('GET', `/${id}`);
  expect(res.status).toBe(200);
  return data<Detail>(res);
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  await db
    .update(schema.projectRequests)
    .set({ status: status as 'new', updatedAt: new Date(), ...extra })
    .where(eq(schema.projectRequests.id, id));
}

const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
const now = at('2026-11-01');

async function seedProject(id: string, name: string, managerId: string, extra: Record<string, unknown> = {}) {
  await db.insert(schema.projects).values({ id, name, projectManagerId: managerId, createdAt: now, updatedAt: now, ...extra });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ── Settings: the scoring model and the board ───────────────────────────────

describe('settings', () => {
  type Settings = {
    id: string | null;
    scoringModel: Array<{ key: string; label: string; weight: number; inverse: boolean }>;
    portfolioBoardIds: string[];
    expenseApprovalLimit: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };
  const model = (weights: number[]) =>
    weights.map((weight, index) => ({ key: `k${index}`, label: `Criterion ${index}`, weight, inverse: index % 2 === 1 }));

  it('starts with the default model, an empty board and no limit', async () => {
    const res = await as(OTHER)('GET', '/settings');
    expect(res.status).toBe(200);
    expect(await data<Settings>(res)).toEqual({
      id: null,
      scoringModel: [
        { key: 'value', label: 'Value', weight: 35, inverse: false },
        { key: 'fit', label: 'Strategic fit', weight: 25, inverse: false },
        { key: 'urgency', label: 'Urgency', weight: 15, inverse: false },
        { key: 'risk', label: 'Risk', weight: 15, inverse: true },
        { key: 'effort', label: 'Effort', weight: 10, inverse: true },
      ],
      portfolioBoardIds: [],
      expenseApprovalLimit: null,
      updatedBy: null,
      updatedAt: null,
    });
    expect((await as(OUTSIDER)('GET', '/settings')).status).toBe(403);
  });

  it('cannot submit a request before the portfolio board has members', async () => {
    const request = await create();
    const res = await as(REQUESTER)('POST', `/${request.id}/submit`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('Add at least one member to the portfolio board first');
    expect((await detail(request.id)).status).toBe('new');
  });

  it('is changed with portfolio:manage only', async () => {
    const res = await as(REQUESTER)('PUT', '/settings', { portfolioBoardIds: [BOARD1] });
    expect(res.status).toBe(403);
    expect((await as(OUTSIDER)('PUT', '/settings', {})).status).toBe(403);
  });

  it('refuses a model whose weights do not add up to 100, or that repeats a key', async () => {
    const send = as(ADMIN);
    const wrong = await send('PUT', '/settings', { scoringModel: model([50, 30, 10]) });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).message).toBe('The weights must add up to 100');
    const repeated = await send('PUT', '/settings', {
      scoringModel: [
        { key: 'a', label: 'A', weight: 50, inverse: false },
        { key: 'a', label: 'B', weight: 50, inverse: true },
      ],
    });
    expect(repeated.status).toBe(400);
    expect((await errorOf(repeated)).message).toBe('Every criterion needs its own key');
    for (const body of [
      { scoringModel: [] },
      { scoringModel: [{ key: 'a', label: 'A', weight: 100.5, inverse: false }] },
      { scoringModel: [{ key: 'a', label: 'A', weight: 100 }] },
      { scoringModel: Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: 'x', weight: 0, inverse: false })) },
      { portfolioBoardIds: [''] },
      { expenseApprovalLimit: -1 },
      { unknown: true },
    ]) {
      const res = await send('PUT', '/settings', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
  });

  it('saves the board, once each member, and the expense limit, and publishes updated', async () => {
    const res = await as(ADMIN)('PUT', '/settings', { portfolioBoardIds: [BOARD1, BOARD2, BOARD1], expenseApprovalLimit: 5000 });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const saved = await data<Settings>(res);
    expect(saved).toMatchObject({ portfolioBoardIds: [BOARD1, BOARD2], expenseApprovalLimit: '5000.00', updatedBy: ADMIN });
    expect(saved.id).toMatch(/^fws_/);
    // The model is untouched: the default stays.
    expect(saved.scoringModel.map((c) => c.weight)).toEqual([35, 25, 15, 15, 10]);
    expect(events()).toEqual([
      {
        entityType: 'flow_workspace_settings',
        action: 'updated',
        entityId: minted(saved.id as string),
        data: expect.objectContaining({ portfolioBoardIds: [BOARD1, BOARD2], expenseApprovalLimit: '5000.00' }),
      },
    ]);
    expect(await data<Settings>(await as(OTHER)('GET', '/settings'))).toMatchObject({ id: saved.id, portfolioBoardIds: [BOARD1, BOARD2] });
    const rows = await db.select().from(schema.flowWorkspaceSettings);
    expect(rows).toHaveLength(1);

    const cleared = await as(ADMIN)('PUT', '/settings', { expenseApprovalLimit: null });
    expect(await data<Settings>(cleared)).toMatchObject({ id: saved.id, portfolioBoardIds: [BOARD1, BOARD2], expenseApprovalLimit: null });
  });

  it('re-scores every open request when the model changes, and only those', async () => {
    const open = await create({ title: 'Open one' });
    const decided = await create({ title: 'Decided one' });
    const unrated = await create({ title: 'Unrated one' });
    expect((await as(BOARD1)('POST', `/${open.id}/score`, { scores: SCORES })).status).toBe(200);
    expect((await as(BOARD1)('POST', `/${decided.id}/score`, { scores: SCORES })).status).toBe(200);
    await setStatus(decided.id, 'approved');
    expect((await detail(open.id)).score).toBe(85);

    published.mockClear();
    // Value now counts for everything: 100 on value alone.
    const onlyValue = [{ key: 'value', label: 'Value', weight: 100, inverse: false }];
    const res = await as(ADMIN)('PUT', '/settings', { scoringModel: onlyValue });
    expect(res.status).toBe(200);
    expect((await data<Settings>(res)).scoringModel).toEqual(onlyValue);
    const reopened = await detail(open.id);
    expect(reopened.score).toBe(100);
    expect(reopened.breakdown).toEqual([{ key: 'value', label: 'Value', weight: 100, inverse: false, value: 5, points: 100 }]);
    // Approved: its score stays; unrated: still none.
    expect((await detail(decided.id)).score).toBe(85);
    expect((await detail(unrated.id)).score).toBeNull();
    expect(actions()).toEqual(['flow_workspace_settings.updated', 'project_request.updated']);
    expect(events()[1]).toMatchObject({ entityId: minted(open.id), data: expect.objectContaining({ id: minted(open.id), score: 100 }) });

    // The ratings stay as they were given: back on the default model the score is the one it was.
    const defaults = [
      { key: 'value', label: 'Value', weight: 35, inverse: false },
      { key: 'fit', label: 'Strategic fit', weight: 25, inverse: false },
      { key: 'urgency', label: 'Urgency', weight: 15, inverse: false },
      { key: 'risk', label: 'Risk', weight: 15, inverse: true },
      { key: 'effort', label: 'Effort', weight: 10, inverse: true },
    ];
    await as(ADMIN)('PUT', '/settings', { scoringModel: defaults });
    expect((await detail(open.id)).score).toBe(85);
    expect((await detail(unrated.id)).score).toBeNull();
  });
});

// ── Create, list, edit, delete ──────────────────────────────────────────────

describe('requests', () => {
  it('files a request with the next REQ number and publishes created', async () => {
    const first = await create({
      title: '  Supplier portal  ',
      businessCase: 'Suppliers confirm orders themselves',
      estimatedCost: 140000,
      estimatedValue: 210000.5,
      neededSkills: [{ skill: 'Backend', hoursPerWeek: 40 }, { skill: 'PM' }],
      desiredStart: '2027-01-11',
      desiredEnd: '2027-06-30',
    });
    expect(first).toMatchObject({
      title: 'Supplier portal',
      requestedBy: REQUESTER,
      businessCase: 'Suppliers confirm orders themselves',
      estimatedCost: '140000.00',
      estimatedValue: '210000.50',
      scores: {},
      score: null,
      neededSkills: [{ skill: 'Backend', hoursPerWeek: 40 }, { skill: 'PM' }],
      desiredStart: '2027-01-11',
      desiredEnd: '2027-06-30',
      status: 'new',
      submittedAt: null,
      projectId: null,
    });
    expect(first.code).toBe(`REQ-${first.number}`);
    expect(events()).toEqual([
      {
        entityType: 'project_request',
        action: 'created',
        entityId: minted(first.id),
        data: expect.objectContaining({ id: minted(first.id), code: first.code, title: 'Supplier portal', status: 'new', score: null }),
      },
    ]);
    const second = await create({ title: 'Second' });
    expect(second.number).toBe(first.number + 1);
    const simple = await create({ title: 'Bare', businessCase: null, desiredStart: null });
    expect(simple).toMatchObject({ businessCase: null, estimatedCost: null, neededSkills: [], desiredStart: null });
  });

  it('refuses bad bodies, dates and amounts', async () => {
    const send = as(REQUESTER);
    const bad = async (body: unknown) => {
      const res = await send('POST', '', body);
      return [res.status, (await errorOf(res)).message] as const;
    };
    expect(await bad({})).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: '   ' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', estimatedCost: -5 })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', desiredStart: '11 Jan' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', neededSkills: [{ skill: '' }] })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', neededSkills: [{ skill: 'a', hours: 4 }] })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', status: 'approved' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ title: 'x', desiredStart: '2027-02-30' })).toEqual([400, 'Use a real calendar date']);
    expect(await bad({ title: 'x', desiredStart: '2027-03-01', desiredEnd: '2027-02-01' })).toEqual([400, 'The end date cannot be before the start date']);
    expect((await as(OUTSIDER)('POST', '', { title: 'x' })).status).toBe(403);
  });

  it('lists ranked by score, those without a score last, filtered and searched', async () => {
    const a = await create({ title: 'Rank low', businessCase: 'needle in the case' });
    const b = await create({ title: 'Rank high' });
    const c = await create({ title: 'Rank unrated' });
    const d = await create({ title: 'Rank tie' });
    await as(ADMIN)('POST', `/${a.id}/score`, { scores: { value: 1, fit: 1, urgency: 1, risk: 5, effort: 5 } });
    await as(ADMIN)('POST', `/${b.id}/score`, { scores: SCORES });
    await as(ADMIN)('POST', `/${d.id}/score`, { scores: { value: 1, fit: 1, urgency: 1, risk: 5, effort: 5 } });
    await setStatus(b.id, 'approved');

    const list = async (query: string) => {
      const res = await as(OTHER)('GET', `?${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { data: Request[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    };
    const ranked = await list('search=Rank');
    expect(ranked.data.map((r) => [r.title, r.score])).toEqual([
      ['Rank high', 85],
      ['Rank low', 20],
      ['Rank tie', 20],
      ['Rank unrated', null],
    ]);
    expect(ranked.pagination).toMatchObject({ totalCount: 4, hasMore: false, cursor: null });
    expect((await list('search=NEEDLE')).data.map((r) => r.id)).toEqual([a.id]);
    expect((await list('search=Rank&status=approved')).data.map((r) => r.id)).toEqual([b.id]);

    // Pages follow the ranking.
    const page1 = await list('search=Rank&limit=2');
    expect(page1.data.map((r) => r.title)).toEqual(['Rank high', 'Rank low']);
    expect(page1.pagination).toMatchObject({ hasMore: true, totalCount: 4 });
    const page2 = await list(`search=Rank&limit=2&cursor=${page1.pagination.cursor}`);
    expect(page2.data.map((r) => r.title)).toEqual(['Rank tie', 'Rank unrated']);
    expect(page2.pagination.hasMore).toBe(false);
    expect(c.status).toBe('new');
    expect((await as(OTHER)('GET', '?status=won')).status).toBe(400);
    expect((await as(OUTSIDER)('GET', '')).status).toBe(403);
  });

  it('is changed by whoever filed it, or portfolio:manage, while it is new or assessing', async () => {
    const request = await create({ title: 'Edit me', estimatedCost: 100, neededSkills: [{ skill: 'QA' }] });
    published.mockClear();
    const res = await as(REQUESTER)('PATCH', `/${request.id}`, {
      title: 'Edited',
      businessCase: 'Now with a case',
      estimatedCost: null,
      estimatedValue: 9.5,
      neededSkills: [{ skill: 'Design', hoursPerWeek: 8 }],
      desiredStart: '2027-03-01',
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await data<Request>(res)).toMatchObject({
      title: 'Edited',
      businessCase: 'Now with a case',
      estimatedCost: null,
      estimatedValue: '9.50',
      neededSkills: [{ skill: 'Design', hoursPerWeek: 8 }],
      desiredStart: '2027-03-01',
    });
    expect(actions()).toEqual(['project_request.updated']);

    const other = await as(OTHER)('PATCH', `/${request.id}`, { title: 'Hijacked' });
    expect(other.status).toBe(403);
    expect((await errorOf(other)).message).toBe('You can only change your own requests');
    expect((await as(ADMIN)('PATCH', `/${request.id}`, { title: 'By the admin' })).status).toBe(200);
    expect((await as(REQUESTER)('PATCH', '/prq_nowhere', { title: 'x' })).status).toBe(404);
    const reversed = await as(REQUESTER)('PATCH', `/${request.id}`, { desiredEnd: '2027-01-01' });
    expect(reversed.status).toBe(400);
    expect((await errorOf(reversed)).message).toBe('The end date cannot be before the start date');
    expect((await as(REQUESTER)('PATCH', `/${request.id}`, { number: 4 })).status).toBe(400);

    await setStatus(request.id, 'approved');
    const decided = await as(REQUESTER)('PATCH', `/${request.id}`, { title: 'Too late' });
    expect(decided.status).toBe(409);
    expect((await errorOf(decided)).message).toBe('Only a new or assessing request can be changed');
  });

  it('shows one request with its score breakdown and the capacity of the skills it needs', async () => {
    await db.insert(schema.flowMemberProfiles).values([
      { id: 'fmp_pr_1', memberId: 'pr_dev1', weeklyHours: '40.00', skills: ['PrBackend'], createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'fmp_pr_2', memberId: 'pr_dev2', weeklyHours: '32.00', skills: ['prbackend'], createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    await seedProject('prj_pr_busy', 'Busy', 'pr_dev1');
    await db.insert(schema.resourceBookings).values({
      id: 'bkg_pr_1', memberId: 'pr_dev1', projectId: 'prj_pr_busy', startsOn: '2027-01-11', endsOn: '2027-01-24', hoursPerWeek: '30.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now,
    });
    const request = await create({
      neededSkills: [{ skill: 'prbackend', hoursPerWeek: 40 }, { skill: 'PrSecurity', hoursPerWeek: 4 }, { skill: 'PrBackend' }],
      desiredStart: '2027-01-13',
      desiredEnd: '2027-01-31',
    });
    await as(ADMIN)('POST', `/${request.id}/score`, { scores: { value: 5, fit: 5, urgency: 4 } });

    const shown = await detail(request.id, as(OTHER));
    expect(shown.fitWindow).toEqual({ from: '2027-01-11', to: '2027-01-31' });
    // Weeks 11 Jan, 18 Jan and 25 Jan: dev1 has 10, 10 and 40 free, dev2 32 each: 42 is the least.
    expect(shown.fit).toEqual([
      { skill: 'prbackend', needHoursPerWeek: 40, freeHoursPerWeek: 42, shortWeeks: 0, weeks: 3, short: false },
      { skill: 'PrSecurity', needHoursPerWeek: 4, freeHoursPerWeek: 0, shortWeeks: 3, weeks: 3, short: true },
      { skill: 'PrBackend', needHoursPerWeek: null, freeHoursPerWeek: 42, shortWeeks: 0, weeks: 3, short: false },
    ]);
    expect(shown.breakdown).toEqual([
      { key: 'value', label: 'Value', weight: 35, inverse: false, value: 5, points: 35 },
      { key: 'fit', label: 'Strategic fit', weight: 25, inverse: false, value: 5, points: 25 },
      { key: 'urgency', label: 'Urgency', weight: 15, inverse: false, value: 4, points: 12 },
      { key: 'risk', label: 'Risk', weight: 15, inverse: true, value: null, points: null },
      { key: 'effort', label: 'Effort', weight: 10, inverse: true, value: null, points: null },
    ]);
    expect(shown.approvals).toEqual([]);
    expect((await as(OTHER)('GET', '/prq_nowhere')).status).toBe(404);
    expect((await as(OUTSIDER)('GET', `/${request.id}`)).status).toBe(403);
    // A request that needs no skill has no fit.
    expect((await detail((await create({ title: 'No skills' })).id)).fit).toEqual([]);
  });

  it('deletes a request with its held bookings and open reviews, and publishes each', async () => {
    const request = await create({ title: 'Delete me' });
    await db.insert(schema.resourceBookings).values({
      id: 'bkg_pr_held', memberId: 'pr_dev1', requestId: request.id, startsOn: '2027-04-05', endsOn: '2027-04-30', hoursPerWeek: '8.00', tentative: true, createdBy: ADMIN, createdAt: now, updatedAt: now,
    });
    expect((await as(REQUESTER)('POST', `/${request.id}/submit`)).status).toBe(200);
    published.mockClear();

    expect((await as(OTHER)('DELETE', `/${request.id}`)).status).toBe(403);
    const res = await as(REQUESTER)('DELETE', `/${request.id}`);
    expect(res.status).toBe(204);
    expect(actions()).toEqual([
      'project_request.deleted',
      'resource_booking.deleted',
      'flow_approval.cancelled',
      'flow_approval.cancelled',
    ]);
    expect(events()[1].data).toMatchObject({ id: 'bkg_pr_held', requestId: request.id, tentative: true });
    expect((await as(ADMIN)('GET', `/${request.id}`)).status).toBe(404);
    const [booking] = await db.select().from(schema.resourceBookings).where(eq(schema.resourceBookings.id, 'bkg_pr_held'));
    expect(booking.deletedAt).not.toBeNull();
    const live = await db
      .select()
      .from(schema.flowApprovals)
      .where(and(eq(schema.flowApprovals.subjectId, request.id), isNull(schema.flowApprovals.deletedAt)));
    expect(live).toEqual([]);
    expect((await as(REQUESTER)('DELETE', `/${request.id}`)).status).toBe(404);

    const converted = await create({ title: 'Converted' });
    await setStatus(converted.id, 'converted');
    const refused = await as(ADMIN)('DELETE', `/${converted.id}`);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe('A converted request cannot be deleted');
  });
});

// ── Score ───────────────────────────────────────────────────────────────────

describe('POST /:id/score', () => {
  it('rates the criteria: the score is the weighted sum, risk and effort count as 6 minus the rating', async () => {
    const request = await create();
    published.mockClear();
    const res = await as(BOARD1)('POST', `/${request.id}/score`, { scores: SCORES });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const scored = await data<Detail>(res);
    expect(scored).toMatchObject({ id: request.id, scores: SCORES, score: 85 });
    expect(scored.breakdown.map((line) => line.points)).toEqual([35, 25, 12, 9, 4]);
    expect(events()).toEqual([
      {
        entityType: 'project_request',
        action: 'updated',
        entityId: minted(request.id),
        data: expect.objectContaining({ id: minted(request.id), scores: SCORES, score: 85 }),
      },
    ]);
    const [row] = await db.select().from(schema.projectRequests).where(eq(schema.projectRequests.id, request.id));
    expect(row.score).toBe('85.00');
  });

  it('keeps a partial rating with no score, and replaces the ratings each time', async () => {
    const request = await create();
    const partial = await data<Detail>(await as(ADMIN)('POST', `/${request.id}/score`, { scores: { value: 5, fit: 3 } }));
    expect(partial).toMatchObject({ scores: { value: 5, fit: 3 }, score: null });
    const best = await data<Detail>(await as(ADMIN)('POST', `/${request.id}/score`, { scores: { value: 5, fit: 5, urgency: 5, risk: 1, effort: 1 } }));
    expect(best.score).toBe(100);
    const worst = await data<Detail>(await as(ADMIN)('POST', `/${request.id}/score`, { scores: { value: 1, fit: 1, urgency: 1, risk: 5, effort: 5 } }));
    expect(worst.score).toBe(20);
  });

  it('is for the board and portfolio:manage', async () => {
    const request = await create();
    const refused = await as(OTHER)('POST', `/${request.id}/score`, { scores: SCORES });
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).message).toBe('Only the portfolio board can score requests');
    expect((await as(BOARD2)('POST', `/${request.id}/score`, { scores: SCORES })).status).toBe(200);
    expect((await as(ADMIN)('POST', `/${request.id}/score`, { scores: SCORES })).status).toBe(200);
    expect((await as(BOARD1)('POST', '/prq_nowhere/score', { scores: SCORES })).status).toBe(404);
  });

  it('refuses ratings off the scale, unknown criteria and a request that is decided', async () => {
    const request = await create();
    const send = as(BOARD1);
    for (const scores of [{ value: 6 }, { value: 0 }, { value: 2.5 }, { value: '5' }]) {
      const res = await send('POST', `/${request.id}/score`, { scores });
      expect(res.status, JSON.stringify(scores)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect((await send('POST', `/${request.id}/score`, {})).status).toBe(400);
    expect((await send('POST', `/${request.id}/score`, { scores: SCORES, extra: 1 })).status).toBe(400);
    const unknown = await send('POST', `/${request.id}/score`, { scores: { zeta: 1, alpha: 2, value: 3 } });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toBe('Unknown scoring criterion: alpha');

    await setStatus(request.id, 'rejected');
    const decided = await send('POST', `/${request.id}/score`, { scores: SCORES });
    expect(decided.status).toBe(409);
    expect((await errorOf(decided)).message).toBe('Only a new or assessing request can be scored');
  });
});

// ── Submit and the board's answer ───────────────────────────────────────────

describe('POST /:id/submit', () => {
  const reviewsOf = (id: string) => detail(id).then((d) => d.approvals);

  it('asks every portfolio board member, publishes submitted and one requested per member', async () => {
    const request = await create();
    published.mockClear();
    const res = await as(REQUESTER)('POST', `/${request.id}/submit`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const submitted = await data<Request & { approvals: Array<{ approverId: string; decision: string; roleLabel: string; step: number }> }>(res);
    expect(submitted).toMatchObject({ id: request.id, status: 'assessing' });
    expect(submitted.submittedAt).not.toBeNull();
    expect(submitted.approvals.map((a) => [a.approverId, a.decision, a.roleLabel, a.step])).toEqual([
      [BOARD1, 'pending', 'Portfolio board', 1],
      [BOARD2, 'pending', 'Portfolio board', 1],
    ]);
    expect(actions()).toEqual(['project_request.submitted', 'flow_approval.requested', 'flow_approval.requested']);
    expect(events()[1].data).toMatchObject({ subjectType: 'project_request', subjectId: minted(request.id), approverId: BOARD1, projectId: null });

    const rows = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.subjectId, request.id));
    expect(rows.map((r) => [r.subjectType, r.approverKind, r.rule, r.createdBy, r.dueAt])).toEqual([
      ['project_request', 'member', { code: 'project_request' }, REQUESTER, null],
      ['project_request', 'member', { code: 'project_request' }, REQUESTER, null],
    ]);
  });

  it('is for whoever filed the request or portfolio:manage, and only once', async () => {
    const request = await create();
    const other = await as(OTHER)('POST', `/${request.id}/submit`);
    expect(other.status).toBe(403);
    expect((await as(OTHER)('POST', '/prq_nowhere/submit')).status).toBe(404);
    expect((await as(ADMIN)('POST', `/${request.id}/submit`)).status).toBe(200);
    const again = await as(REQUESTER)('POST', `/${request.id}/submit`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Only a new request can be submitted');
    expect(await reviewsOf(request.id)).toHaveLength(2);
  });

  it('settles the request as approved when every board member approves, and as rejected at the first rejection', async () => {
    const request = await create({ title: 'Approve me' });
    await as(REQUESTER)('POST', `/${request.id}/submit`);
    const rows = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.subjectId, request.id));
    const byApprover = new Map(rows.map((r) => [r.approverId, r.id]));

    const one = await decideApproval(db, { approvalId: byApprover.get(BOARD1) as string, actor: BOARD1, decision: 'approved' });
    expect(one).toMatchObject({ ok: true, outcome: 'pending', resolved: false });
    expect((await detail(request.id)).status).toBe('assessing');
    const two = await decideApproval(db, { approvalId: byApprover.get(BOARD2) as string, actor: BOARD2, decision: 'approved_with_conditions', note: 'Start after Q1' });
    expect(two).toMatchObject({ ok: true, outcome: 'approved', resolved: true });
    const approved = await detail(request.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvals.map((a) => [a.approverId, a.decision, a.note])).toEqual([
      [BOARD1, 'approved', null],
      [BOARD2, 'approved_with_conditions', 'Start after Q1'],
    ]);

    const declined = await create({ title: 'Decline me' });
    await as(REQUESTER)('POST', `/${declined.id}/submit`);
    const declinedRows = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.subjectId, declined.id));
    const rejectedBy = declinedRows.find((r) => r.approverId === BOARD2);
    const result = await decideApproval(db, { approvalId: rejectedBy?.id as string, actor: BOARD2, decision: 'rejected', note: 'No budget' });
    expect(result).toMatchObject({ ok: true, outcome: 'rejected', resolved: true });
    const rejected = await detail(declined.id);
    expect(rejected.status).toBe('rejected');
    // Nobody is asked about a settled request: the other open review is cleared.
    expect(rejected.approvals.map((a) => [a.approverId, a.decision, a.note])).toEqual([[BOARD2, 'rejected', 'No budget']]);
    // A decided request can be neither edited nor scored nor submitted again.
    expect((await as(ADMIN)('PATCH', `/${declined.id}`, { title: 'x' })).status).toBe(409);
    expect((await as(ADMIN)('POST', `/${declined.id}/submit`)).status).toBe(409);
  });
});

// ── Convert ─────────────────────────────────────────────────────────────────

describe('POST /:id/convert', () => {
  beforeAll(async () => {
    await seedProject('prj_cv_a', 'Converted A', PM);
    await seedProject('prj_cv_b', 'Converted B', 'user_pr_other_pm');
    await seedProject('prj_cv_c', 'Converted C', PM);
    await seedProject('prj_cv_gone', 'Gone', PM, { deletedAt: now });
  });

  const approved = async (extra: Record<string, unknown> = {}) => {
    const request = await create(extra);
    await setStatus(request.id, 'approved');
    return request;
  };

  it('links the project, marks the request converted, moves the held people onto the project and publishes', async () => {
    const request = await approved({ title: 'Convert me' });
    await db.insert(schema.resourceBookings).values({
      id: 'bkg_cv_held', memberId: 'pr_dev2', requestId: request.id, startsOn: '2027-03-01', endsOn: '2027-03-31', hoursPerWeek: '16.00', tentative: true, createdBy: ADMIN, createdAt: now, updatedAt: now,
    });
    published.mockClear();
    const res = await as(PM)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_a' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await data<Request>(res)).toMatchObject({ id: request.id, status: 'converted', projectId: 'prj_cv_a' });
    expect(actions()).toEqual(['project_request.converted', 'resource_booking.updated']);
    expect(events()[0].data).toMatchObject({ id: minted(request.id), status: 'converted', projectId: 'prj_cv_a' });
    expect(events()[1].data).toMatchObject({ id: 'bkg_cv_held', projectId: 'prj_cv_a', requestId: null, tentative: true });
    const [booking] = await db.select().from(schema.resourceBookings).where(eq(schema.resourceBookings.id, 'bkg_cv_held'));
    expect([booking.projectId, booking.requestId, booking.tentative]).toEqual(['prj_cv_a', null, true]);
    expect((await detail(request.id)).projectId).toBe('prj_cv_a');
  });

  it('needs an approved request, a live project the caller manages that no other request is linked to', async () => {
    const fresh = await create({ title: 'Still new' });
    const notApproved = await as(PM)('POST', `/${fresh.id}/convert`, { projectId: 'prj_cv_c' });
    expect(notApproved.status).toBe(409);
    expect((await errorOf(notApproved)).message).toBe('Only an approved request can be converted');

    const request = await approved();
    expect((await as(PM)('POST', '/prq_nowhere/convert', { projectId: 'prj_cv_c' })).status).toBe(404);
    expect((await as(PM)('POST', `/${request.id}/convert`, { projectId: 'prj_nowhere' })).status).toBe(404);
    expect((await as(PM)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_gone' })).status).toBe(404);
    const foreign = await as(PM)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_b' });
    expect(foreign.status).toBe(403);
    expect((await errorOf(foreign)).message).toBe('You do not have permission to link this project');
    expect((await as(REQUESTER)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_c' })).status).toBe(403);
    expect((await as(PM)('POST', `/${request.id}/convert`, {})).status).toBe(400);
    expect((await as(PM)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_c', status: 'x' })).status).toBe(400);

    // portfolio:manage may link any project.
    expect((await as(ADMIN)('POST', `/${request.id}/convert`, { projectId: 'prj_cv_b' })).status).toBe(200);
    const second = await approved();
    const linked = await as(PM)('POST', `/${second.id}/convert`, { projectId: 'prj_cv_a' });
    expect(linked.status).toBe(409);
    expect((await errorOf(linked)).message).toBe('This project is already linked to another request');
  });
});

// ── Funnel ──────────────────────────────────────────────────────────────────

describe('GET /funnel', () => {
  it('counts requests per status, the new ones of the last week and the age of the oldest assessment', async () => {
    const all = ((await (await as(ADMIN)('GET', '?limit=200')).json()) as { data: Request[] }).data;
    const tally: Record<string, number> = { new: 0, assessing: 0, approved: 0, rejected: 0, converted: 0 };
    for (const r of all) tally[r.status] += 1;
    const res = await as(OTHER)('GET', '/funnel');
    expect(res.status).toBe(200);
    const funnel = await data<{ counts: Record<string, number>; newLast7Days: number; oldestAssessingDays: number | null }>(res);
    expect(funnel.counts).toEqual(tally);
    expect(funnel.newLast7Days).toBe(tally.new);
    expect(tally.assessing).toBeGreaterThan(0);
    expect(funnel.oldestAssessingDays).toBe(0);
    expect((await as(OUTSIDER)('GET', '/funnel')).status).toBe(403);

    // A request that has waited three days.
    const waiting = await create({ title: 'Waiting' });
    await setStatus(waiting.id, 'assessing', { submittedAt: new Date(Date.now() - 3.5 * 86_400_000) });
    expect((await data<{ oldestAssessingDays: number }>(await as(OTHER)('GET', '/funnel'))).oldestAssessingDays).toBe(3);
    await setStatus(waiting.id, 'new', { submittedAt: null });
  });
});

// ── Roadmap ─────────────────────────────────────────────────────────────────

describe('GET /roadmap', () => {
  type Roadmap = {
    from: string;
    to: string;
    quarters: Array<{ key: string; startsOn: string; endsOn: string; bookedHours: number; capacityHours: number; percent: number | null }>;
    months: Array<{ key: string; startsOn: string; endsOn: string; bookedHours: number; capacityHours: number; percent: number | null }>;
    items: Array<{ type: string; id: string; code: string | null; name: string; accessible: boolean; status: string; startsOn: string; endsOn: string; score: number | null }>;
  };

  beforeAll(async () => {
    await seedProject('prj_rm_a', 'Roadmap Alpha', PM, { status: 'Active', startDate: at('2026-10-15'), endDate: at('2027-02-15') });
    await seedProject('prj_rm_b', 'Roadmap Beta', 'user_pr_other_pm', { status: 'Planning', startDate: at('2026-12-01'), endDate: null });
    await seedProject('prj_rm_done', 'Done', PM, { status: 'Completed', startDate: at('2026-10-15'), endDate: at('2026-11-15') });
    await seedProject('prj_rm_early', 'Early', PM, { status: 'Active', startDate: at('2026-01-15'), endDate: at('2026-03-15') });
    await seedProject('prj_rm_undated', 'Undated', PM, { status: 'Active' });
    await db.insert(schema.projectRequests).values([
      { id: 'prq_rm_appr', number: 801, title: 'Self-service returns', requestedBy: ADMIN, status: 'approved', score: '72.00', desiredStart: '2027-01-11', desiredEnd: '2027-03-31', createdBy: ADMIN, createdAt: new Date(), updatedAt: now },
      { id: 'prq_rm_if', number: 802, title: 'Supplier portal', requestedBy: ADMIN, status: 'assessing', score: '85.00', desiredStart: '2026-12-01', desiredEnd: null, createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'prq_rm_new', number: 803, title: 'Not yet submitted', requestedBy: ADMIN, status: 'new', desiredStart: '2026-12-01', createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'prq_rm_conv', number: 804, title: 'Already a project', requestedBy: ADMIN, status: 'converted', desiredStart: '2026-12-01', createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'prq_rm_nodate', number: 805, title: 'No dates', requestedBy: ADMIN, status: 'approved', createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.flowMemberProfiles).values({ id: 'fmp_rm_1', memberId: 'rm_anna', weeklyHours: '40.00', skills: [], createdBy: ADMIN, createdAt: now, updatedAt: now });
    await db.insert(schema.resourceBookings).values([
      // Four weeks in October (Mondays 5, 12, 19 and 26 Oct): 80 booked hours.
      { id: 'bkg_rm_1', memberId: 'rm_anna', projectId: 'prj_rm_a', startsOn: '2026-10-05', endsOn: '2026-10-30', hoursPerWeek: '20.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now },
      // A tentative hold for the supplier portal in December.
      { id: 'bkg_rm_2', memberId: 'rm_anna', requestId: 'prq_rm_if', startsOn: '2026-12-07', endsOn: '2026-12-11', hoursPerWeek: '10.00', tentative: true, createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
  });

  const get = async (who: Send, query: string) => {
    const res = await who('GET', `/roadmap?${query}`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    return data<Roadmap>(res);
  };

  it('lists current projects and approved or assessing requests with dates, in start order', async () => {
    const roadmap = await get(as(PM), 'from=2026-10-01&to=2027-03-31');
    expect(roadmap.from).toBe('2026-10-01');
    expect(roadmap.to).toBe('2027-03-31');
    // Requests other tests filed with a date are on the roadmap too: look at the ones seeded here.
    const seeded = roadmap.items.filter((i) => i.id.startsWith('prj_rm') || i.id.startsWith('prq_rm'));
    expect(seeded.map((i) => [i.type, i.name, i.code, i.status, i.startsOn, i.endsOn, i.score])).toEqual([
      ['project', 'Roadmap Alpha', null, 'Active', '2026-10-15', '2027-02-15', null],
      // Beta has a start and no end: it is a single day. A project comes before a request that starts the same day.
      ['project', 'Other project', null, 'Planning', '2026-12-01', '2026-12-01', null],
      ['request', 'Supplier portal', 'REQ-802', 'assessing', '2026-12-01', '2026-12-01', 85],
      ['request', 'Self-service returns', 'REQ-801', 'approved', '2027-01-11', '2027-03-31', 72],
    ]);
  });

  it('names a project only for those who are in it', async () => {
    const forPm = await get(as(PM), 'from=2026-10-01&to=2027-03-31');
    expect(forPm.items.filter((i) => i.type === 'project').map((i) => [i.name, i.accessible])).toEqual([
      ['Roadmap Alpha', true],
      ['Other project', false],
    ]);
    const forReader = await get(as(OTHER), 'from=2026-10-01&to=2027-03-31');
    expect(forReader.items.filter((i) => i.type === 'project').map((i) => [i.name, i.accessible])).toEqual([
      ['Other project', false],
      ['Other project', false],
    ]);
    expect(forReader.items.find((i) => i.type === 'request')).toMatchObject({ accessible: true });
  });

  it('keeps to the quarters asked for, widened to whole quarters', async () => {
    const q4 = await get(as(PM), 'from=2026-11-20&to=2026-12-05');
    expect(q4.from).toBe('2026-10-01');
    expect(q4.to).toBe('2026-12-31');
    expect(q4.quarters.map((q) => [q.key, q.startsOn, q.endsOn])).toEqual([['2026-Q4', '2026-10-01', '2026-12-31']]);
    expect(q4.months.map((m) => [m.key, m.startsOn, m.endsOn])).toEqual([
      ['2026-10', '2026-10-01', '2026-10-31'],
      ['2026-11', '2026-11-01', '2026-11-30'],
      ['2026-12', '2026-12-01', '2026-12-31'],
    ]);
    // Early (Jan to Mar 2026), the completed project and the undated one are not here; the requests starting in Q1 are not either.
    expect(q4.items.map((i) => i.name)).toEqual(['Roadmap Alpha', 'Other project', 'Supplier portal']);
  });

  it('draws the team load as a line per month and quarter: firm bookings, and tentative ones when asked', async () => {
    const roadmap = await get(as(PM), 'from=2026-10-01&to=2026-12-31');
    const october = roadmap.months[0];
    expect(october.bookedHours).toBe(80);
    expect(october.capacityHours).toBeGreaterThan(0);
    expect(october.percent).toBe(Math.round((80 / october.capacityHours) * 100 * 100) / 100);
    expect(roadmap.months[2].bookedHours).toBe(0);
    expect(roadmap.quarters[0].bookedHours).toBe(80);
    expect(roadmap.quarters[0].capacityHours).toBe(roadmap.months.reduce((sum, m) => sum + m.capacityHours, 0));

    const withTentative = await get(as(PM), 'from=2026-10-01&to=2026-12-31&tentative=true');
    expect(withTentative.months[2].bookedHours).toBe(10);
    expect(withTentative.quarters[0].bookedHours).toBe(90);
  });

  it('refuses bad dates, a reversed range, more than eight quarters and a bad flag', async () => {
    const bad = async (query: string) => {
      const res = await as(PM)('GET', `/roadmap?${query}`);
      return [res.status, (await errorOf(res)).message] as const;
    };
    expect(await bad('from=2026-02-30')).toEqual([400, 'Use a real calendar date']);
    expect(await bad('to=2026-13-01')).toEqual([400, 'Use a real calendar date']);
    expect(await bad('from=2026-12-01&to=2026-11-01')).toEqual([400, 'The end date cannot be before the start date']);
    expect(await bad('from=2026-01-01&to=2028-01-01')).toEqual([400, 'The roadmap spans at most 8 quarters']);
    expect(await bad('from=soon')).toEqual([400, 'Invalid query parameters']);
    expect(await bad('tentative=perhaps')).toEqual([400, 'Invalid query parameters']);
    expect((await as(PM)('GET', '/roadmap?from=2026-01-01&to=2027-12-31')).status).toBe(200);
    expect((await as(OUTSIDER)('GET', '/roadmap')).status).toBe(403);
  });
});

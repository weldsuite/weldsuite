/**
 * DB-backed integration tests for capacity: /api/capacity (load per member and
 * week, bookings, resource requests, member profiles). Runs against the
 * TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json), so every status code, message and event
 * payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { capacityRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const ADMIN = 'user_cap_admin';
const PM = 'user_cap_pm';
const MEMBER = 'user_cap_member';
const VIEWER = 'user_cap_viewer';
const READER = 'user_cap_reader';
const OUTSIDER = 'user_cap_outsider';
const SCOPE_ALL = 'user_cap_scope_all';

const KEYS: Record<string, string[]> = {
  [ADMIN]: ['portfolio:read', 'portfolio:manage', 'projects:read', 'projects:update'],
  // A project manager with the member defaults: no portfolio keys at all.
  [PM]: ['projects:read', 'projects:update'],
  [MEMBER]: ['portfolio:read', 'projects:read', 'projects:update'],
  [VIEWER]: ['portfolio:read', 'projects:read', 'projects:update'],
  [READER]: ['portfolio:read'],
  [OUTSIDER]: ['projects:read'],
  [SCOPE_ALL]: ['portfolio:read', 'projects:read', 'projects:update', 'projects:scope:all'],
};

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string): Send {
  const { request } = createTestApp('/api/capacity', capacityRoutes, {
    context: { userId, permissions: permissions(...(KEYS[userId] ?? [])), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/capacity${path}`, {
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

type Cell = { hours: number; tentativeHours: number; percent: number | null; band: string };
type Row = { projectId: string | null; requestId: string | null; name: string; accessible: boolean; hours: number[]; tentativeHours: number[] };
type MemberLoad = { memberId: string; weeklyHours: number; skills: string[]; hasProfile: boolean; cells: Cell[]; projects: Row[] };
type Load = {
  from: string;
  to: string;
  tentative: boolean;
  weeks: Array<{ week: string; startsOn: string; endsOn: string }>;
  totals: Array<{ bookedHours: number; capacityHours: number }>;
  members: MemberLoad[];
  summary: { memberCount: number; bookedHours: number; capacityHours: number; percent: number | null; overbookedPersonWeeks: number };
};
type Booking = {
  id: string;
  memberId: string;
  projectId: string | null;
  requestId: string | null;
  startsOn: string;
  endsOn: string;
  hoursPerWeek: string;
  tentative: boolean;
  createdBy: string;
};
type ResourceRequest = {
  id: string;
  projectId: string;
  projectName: string;
  skill: string;
  hoursPerWeek: string;
  startsOn: string;
  endsOn: string;
  status: string;
  bookingId: string | null;
};

const RANGE = 'from=2026-11-02&to=2026-11-22';

async function load(who: Send, query = RANGE): Promise<Load> {
  const res = await who('GET', `?${query}`);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return data<Load>(res);
}

const memberOf = (loaded: Load, memberId: string) => {
  const found = loaded.members.find((m) => m.memberId === memberId);
  expect(found, `member ${memberId}`).toBeDefined();
  return found as MemberLoad;
};
const hours = (loaded: Load, memberId: string) => memberOf(loaded, memberId).cells.map((c) => c.hours);

const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
const now = at('2026-11-01');

async function seedProject(id: string, name: string, managerId: string, extra: Record<string, unknown> = {}) {
  await db.insert(schema.projects).values({ id, name, projectManagerId: managerId, createdAt: now, updatedAt: now, ...extra });
}

let taskSeq = 0;
async function seedTask(projectId: string, assigneeId: string | null, extra: Record<string, unknown> = {}) {
  taskSeq += 1;
  await db.insert(schema.tasks).values({
    id: `tsk_cap_${taskSeq}`,
    projectId,
    title: 'Task',
    status: 'in_progress',
    assigneeId,
    startDate: at('2026-11-02'),
    dueDate: at('2026-11-06'),
    estimatedHours: '10.00',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // Alpha: the PM manages it, a member and a viewer are in it. Beta is someone else's.
  await seedProject('prj_cap_a', 'Alpha', PM);
  await seedProject('prj_cap_b', 'Beta', 'user_cap_other_pm');
  await db.insert(schema.projectMembers).values([
    { id: 'pm_cap_m', projectId: 'prj_cap_a', userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: 'pm_cap_v', projectId: 'prj_cap_a', userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}, 60_000);

// ── Load ────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  beforeAll(async () => {
    await db.insert(schema.flowMemberProfiles).values([
      { id: 'fmp_cap_1', memberId: 'cap_anna', weeklyHours: '40.00', skills: ['Frontend', 'React'], createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'fmp_cap_2', memberId: 'cap_bob', weeklyHours: '32.00', skills: ['Backend'], createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.projectRequests).values({
      id: 'prq_cap_1',
      number: 901,
      title: 'Supplier portal',
      requestedBy: ADMIN,
      status: 'assessing',
      createdBy: ADMIN,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.resourceBookings).values([
      { id: 'bkg_cap_1', memberId: 'cap_anna', projectId: 'prj_cap_a', startsOn: '2026-11-02', endsOn: '2026-11-13', hoursPerWeek: '20.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'bkg_cap_2', memberId: 'cap_anna', requestId: 'prq_cap_1', startsOn: '2026-11-09', endsOn: '2026-11-20', hoursPerWeek: '10.00', tentative: true, createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    // Anna has a 10 hour task on Beta in the first week; none of her tasks may show its title.
    await seedTask('prj_cap_b', 'cap_anna', { title: 'Secret roadmap task' });
    await seedTask('prj_cap_a', 'cap_bob', { startDate: at('2026-11-09'), dueDate: at('2026-11-13'), estimatedHours: '16.00' });
    // Never load: done, cancelled, no estimate, no assignee, deleted, and a task of a deleted project.
    await seedTask('prj_cap_b', 'cap_anna', { status: 'done' });
    await seedTask('prj_cap_b', 'cap_anna', { status: 'cancelled' });
    await seedTask('prj_cap_b', 'cap_anna', { estimatedHours: null });
    await seedTask('prj_cap_b', null);
    await seedTask('prj_cap_b', 'cap_anna', { deletedAt: now });
    await seedProject('prj_cap_gone', 'Gone', PM, { deletedAt: now });
    await seedTask('prj_cap_gone', 'cap_anna');
  });

  it('needs portfolio:read', async () => {
    expect((await as(OUTSIDER)('GET', `?${RANGE}`)).status).toBe(403);
  });

  it('answers the weeks, the hours per member and week, and the percentage of contract hours', async () => {
    const loaded = await load(as(ADMIN));
    expect(loaded.from).toBe('2026-11-02');
    expect(loaded.to).toBe('2026-11-22');
    expect(loaded.tentative).toBe(false);
    expect(loaded.weeks).toEqual([
      { week: '2026-W45', startsOn: '2026-11-02', endsOn: '2026-11-08' },
      { week: '2026-W46', startsOn: '2026-11-09', endsOn: '2026-11-15' },
      { week: '2026-W47', startsOn: '2026-11-16', endsOn: '2026-11-22' },
    ]);
    // Anna: the booking on Alpha (20) and her task on Beta (10) in week 1, the booking alone after.
    expect(hours(loaded, 'cap_anna')).toEqual([30, 20, 0]);
    expect(memberOf(loaded, 'cap_anna').cells).toEqual([
      { hours: 30, tentativeHours: 0, percent: 75, band: 'ok' },
      { hours: 20, tentativeHours: 0, percent: 50, band: 'ok' },
      { hours: 0, tentativeHours: 0, percent: 0, band: 'none' },
    ]);
    expect(memberOf(loaded, 'cap_anna')).toMatchObject({ weeklyHours: 40, skills: ['Frontend', 'React'], hasProfile: true });
    expect(hours(loaded, 'cap_bob')).toEqual([0, 16, 0]);
    expect(memberOf(loaded, 'cap_bob').cells[1]).toEqual({ hours: 16, tentativeHours: 0, percent: 50, band: 'ok' });
  });

  it('lists members without a profile with 40 contract hours, the people of current projects included', async () => {
    const loaded = await load(as(ADMIN));
    for (const id of [MEMBER, VIEWER, PM, 'user_cap_other_pm']) {
      expect(memberOf(loaded, id)).toMatchObject({ weeklyHours: 40, skills: [], hasProfile: false });
      expect(hours(loaded, id)).toEqual([0, 0, 0]);
    }
    expect(loaded.members.map((m) => m.memberId)).toEqual([...loaded.members.map((m) => m.memberId)].sort());
  });

  it('adds up the team: totals per week and a summary', async () => {
    const loaded = await load(as(ADMIN), `${RANGE}&skill=backend`);
    expect(loaded.members.map((m) => m.memberId)).toEqual(['cap_bob']);
    expect(loaded.totals).toEqual([
      { bookedHours: 0, capacityHours: 32 },
      { bookedHours: 16, capacityHours: 32 },
      { bookedHours: 0, capacityHours: 32 },
    ]);
    expect(loaded.summary).toEqual({ memberCount: 1, bookedHours: 16, capacityHours: 96, percent: 16.67, overbookedPersonWeeks: 0 });
  });

  it('counts tentative bookings only when asked, and says how much of a week is tentative', async () => {
    const withTentative = await load(as(ADMIN), `${RANGE}&tentative=true`);
    expect(withTentative.tentative).toBe(true);
    // The held 10 hours add to weeks 2 and 3 (11-09 to 11-20).
    expect(hours(withTentative, 'cap_anna')).toEqual([30, 30, 10]);
    expect(memberOf(withTentative, 'cap_anna').cells.map((c) => c.tentativeHours)).toEqual([0, 10, 10]);
    expect(hours(await load(as(ADMIN), `${RANGE}&tentative=false`), 'cap_anna')).toEqual([30, 20, 0]);
    expect(hours(await load(as(ADMIN), `${RANGE}&tentative=1`), 'cap_anna')).toEqual([30, 30, 10]);
  });

  it('shows the projects behind the hours, named only for projects the caller is in', async () => {
    const member = await load(as(MEMBER), `${RANGE}&tentative=true`);
    expect(memberOf(member, 'cap_anna').projects).toEqual([
      { projectId: 'prj_cap_a', requestId: null, name: 'Alpha', accessible: true, hours: [20, 20, 0], tentativeHours: [0, 0, 0] },
      { projectId: 'prj_cap_b', requestId: null, name: 'Other project', accessible: false, hours: [10, 0, 0], tentativeHours: [0, 0, 0] },
      { projectId: null, requestId: 'prq_cap_1', name: 'Supplier portal', accessible: true, hours: [0, 10, 10], tentativeHours: [0, 10, 10] },
    ]);
    const reader = await load(as(READER));
    expect(memberOf(reader, 'cap_anna').projects.map((p) => [p.name, p.accessible])).toEqual([
      ['Other project', false],
      ['Other project', false],
    ]);
    const all = await load(as(SCOPE_ALL));
    expect(memberOf(all, 'cap_anna').projects.map((p) => [p.name, p.accessible])).toEqual([
      ['Alpha', true],
      ['Beta', true],
    ]);
  });

  it('never returns the title of a task', async () => {
    for (const who of [ADMIN, MEMBER, READER, SCOPE_ALL]) {
      const res = await as(who)('GET', `?${RANGE}&tentative=true`);
      expect(JSON.stringify(await res.json())).not.toContain('Secret roadmap task');
    }
  });

  it('leaves out the bookings of a rejected request and of a deleted project', async () => {
    await db.insert(schema.projectRequests).values({ id: 'prq_cap_rej', number: 902, title: 'Rejected', requestedBy: ADMIN, status: 'rejected', createdBy: ADMIN, createdAt: now, updatedAt: now });
    await db.insert(schema.resourceBookings).values([
      { id: 'bkg_cap_rej', memberId: 'cap_bob', requestId: 'prq_cap_rej', startsOn: '2026-11-02', endsOn: '2026-11-08', hoursPerWeek: '8.00', tentative: true, createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'bkg_cap_gone', memberId: 'cap_bob', projectId: 'prj_cap_gone', startsOn: '2026-11-02', endsOn: '2026-11-08', hoursPerWeek: '8.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    const loaded = await load(as(ADMIN), `${RANGE}&tentative=true`);
    expect(hours(loaded, 'cap_bob')).toEqual([0, 16, 0]);
  });

  it('refuses bad dates, a reversed range, a range over 26 weeks and a bad flag', async () => {
    const send = as(ADMIN);
    const bad = async (query: string) => {
      const res = await send('GET', `?${query}`);
      return [res.status, (await errorOf(res)).message] as const;
    };
    expect(await bad('from=2026-02-30')).toEqual([400, 'Use a real calendar date']);
    expect(await bad('to=2026-13-01')).toEqual([400, 'Use a real calendar date']);
    expect(await bad('from=2026-11-10&to=2026-11-09')).toEqual([400, 'The end date cannot be before the start date']);
    expect(await bad('from=2026-11-02&to=2027-05-03')).toEqual([400, 'The range can span at most 26 weeks']);
    expect(await bad('from=tomorrow')).toEqual([400, 'Invalid query parameters']);
    expect(await bad('tentative=maybe')).toEqual([400, 'Invalid query parameters']);
    // Exactly 26 weeks is fine.
    expect((await send('GET', '?from=2026-11-02&to=2027-05-02')).status).toBe(200);
  });
});

// ── Bookings ────────────────────────────────────────────────────────────────

describe('bookings', () => {
  const booking = (extra: Record<string, unknown> = {}) => ({
    memberId: 'bk_anna',
    projectId: 'prj_cap_a',
    startsOn: '2026-12-01',
    endsOn: '2026-12-31',
    hoursPerWeek: 12.5,
    ...extra,
  });

  it('books a member on a project for a period, hours per week, and publishes created', async () => {
    const res = await as(ADMIN)('POST', '/bookings', booking());
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const created = await data<Booking>(res);
    expect(created).toMatchObject({
      memberId: 'bk_anna',
      projectId: 'prj_cap_a',
      requestId: null,
      startsOn: '2026-12-01',
      endsOn: '2026-12-31',
      hoursPerWeek: '12.50',
      tentative: false,
      createdBy: ADMIN,
    });
    expect(created.id).toMatch(/^bkg_/);
    expect(events()).toEqual([
      {
        entityType: 'resource_booking',
        action: 'created',
        entityId: minted(created.id),
        data: expect.objectContaining({ id: minted(created.id), memberId: 'bk_anna', projectId: 'prj_cap_a', hoursPerWeek: '12.50', tentative: false }),
      },
    ]);
  });

  it('lists bookings by member, project and overlap, newest first', async () => {
    const send = as(ADMIN);
    await send('POST', '/bookings', booking({ memberId: 'bk_list', startsOn: '2027-03-01', endsOn: '2027-03-05' }));
    await send('POST', '/bookings', booking({ memberId: 'bk_list', startsOn: '2027-06-01', endsOn: '2027-06-05' }));
    const all = await send('GET', '/bookings?memberId=bk_list');
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Booking[]; pagination: { totalCount: number; hasMore: boolean } };
    expect(body.data.map((b) => b.startsOn)).toEqual(['2027-06-01', '2027-03-01']);
    expect(body.pagination).toMatchObject({ totalCount: 2, hasMore: false });
    const overlapping = (await (await send('GET', '/bookings?memberId=bk_list&from=2027-03-03&to=2027-04-01')).json()) as { data: Booking[] };
    expect(overlapping.data.map((b) => b.startsOn)).toEqual(['2027-03-01']);
    const paged = (await (await send('GET', '/bookings?memberId=bk_list&limit=1')).json()) as { data: Booking[]; pagination: { hasMore: boolean; cursor: string } };
    expect(paged.data).toHaveLength(1);
    expect(paged.pagination.hasMore).toBe(true);
    const next = (await (await send('GET', `/bookings?memberId=bk_list&limit=1&cursor=${paged.pagination.cursor}`)).json()) as { data: Booking[] };
    expect(next.data.map((b) => b.startsOn)).toEqual(['2027-03-01']);
    expect((await as(OUTSIDER)('GET', '/bookings')).status).toBe(403);
  });

  it('refuses a booking that is not for exactly one of a project and a request', async () => {
    const send = as(ADMIN);
    const both = await send('POST', '/bookings', booking({ requestId: 'prq_cap_1', tentative: true }));
    expect(both.status).toBe(400);
    expect((await errorOf(both)).message).toBe('A booking is for a project or for a request, not both and not neither');
    const neither = await send('POST', '/bookings', booking({ projectId: undefined }));
    expect(neither.status).toBe(400);
    expect((await errorOf(neither)).message).toBe('A booking is for a project or for a request, not both and not neither');
  });

  it('refuses bad shapes, dates and hours', async () => {
    const send = as(ADMIN);
    const bad = async (extra: Record<string, unknown>) => {
      const res = await send('POST', '/bookings', booking(extra));
      return [res.status, (await errorOf(res)).message] as const;
    };
    expect(await bad({ hoursPerWeek: 0 })).toEqual([400, 'Invalid request body']);
    expect(await bad({ hoursPerWeek: 169 })).toEqual([400, 'Invalid request body']);
    expect(await bad({ startsOn: '1 Dec' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ memberId: '' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ id: 'bkg_hijack' })).toEqual([400, 'Invalid request body']);
    expect(await bad({ startsOn: '2026-02-30' })).toEqual([400, 'Use a real calendar date']);
    expect(await bad({ startsOn: '2026-12-10', endsOn: '2026-12-09' })).toEqual([400, 'The end date cannot be before the start date']);
    const notJson = await send('POST', '/bookings', 'not an object');
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toBe('Invalid request body');
  });

  it('holds a person for a request only tentatively, and only for a request still in play', async () => {
    const send = as(ADMIN);
    await db.insert(schema.projectRequests).values([
      { id: 'prq_cap_hold', number: 910, title: 'Hold me', requestedBy: ADMIN, status: 'new', createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'prq_cap_done', number: 911, title: 'Converted', requestedBy: ADMIN, status: 'converted', createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    const firm = await send('POST', '/bookings', booking({ projectId: undefined, requestId: 'prq_cap_hold' }));
    expect(firm.status).toBe(400);
    expect((await errorOf(firm)).message).toBe('A booking held for a request is always tentative');

    const held = await send('POST', '/bookings', booking({ projectId: undefined, requestId: 'prq_cap_hold', tentative: true }));
    expect(held.status).toBe(201);
    expect(await data<Booking>(held)).toMatchObject({ projectId: null, requestId: 'prq_cap_hold', tentative: true });

    const closed = await send('POST', '/bookings', booking({ projectId: undefined, requestId: 'prq_cap_done', tentative: true }));
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).message).toBe('This request is no longer open for bookings');
    const missing = await send('POST', '/bookings', booking({ projectId: undefined, requestId: 'prq_nowhere', tentative: true }));
    expect(missing.status).toBe(404);
  });

  it('finds the project, 404 when it is missing or deleted', async () => {
    const send = as(ADMIN);
    expect((await send('POST', '/bookings', booking({ projectId: 'prj_nowhere' }))).status).toBe(404);
    expect((await send('POST', '/bookings', booking({ projectId: 'prj_cap_gone' }))).status).toBe(404);
  });

  it('lets portfolio:manage book anyone, a project manager book on their own project, and a member book themselves', async () => {
    // The PM has no portfolio keys: the project manager of Alpha books anyone on Alpha, not on Beta.
    expect((await as(PM)('POST', '/bookings', booking({ memberId: 'bk_other' }))).status).toBe(201);
    const beta = await as(PM)('POST', '/bookings', booking({ projectId: 'prj_cap_b' }));
    expect(beta.status).toBe(403);
    expect((await errorOf(beta)).message).toBe('You do not have permission to book people on this');
    // A member books themselves on a project they write to, not someone else.
    expect((await as(MEMBER)('POST', '/bookings', booking({ memberId: MEMBER }))).status).toBe(201);
    expect((await as(MEMBER)('POST', '/bookings', booking({ memberId: 'bk_other' }))).status).toBe(403);
    expect((await as(MEMBER)('POST', '/bookings', booking({ memberId: MEMBER, projectId: 'prj_cap_b' }))).status).toBe(403);
    // A viewer cannot write to the project, so cannot book themselves on it.
    expect((await as(VIEWER)('POST', '/bookings', booking({ memberId: VIEWER }))).status).toBe(403);
    // A request-held booking needs portfolio:manage.
    expect((await as(PM)('POST', '/bookings', booking({ projectId: undefined, requestId: 'prq_cap_hold', tentative: true }))).status).toBe(403);
    // No key to book with at all.
    expect((await as(OUTSIDER)('POST', '/bookings', booking())).status).toBe(403);
    expect((await as(SCOPE_ALL)('POST', '/bookings', booking({ projectId: 'prj_cap_b' }))).status).toBe(201);
  });

  it('changes the period, hours and tentative of a booking and publishes updated', async () => {
    const created = await data<Booking>(await as(ADMIN)('POST', '/bookings', booking({ memberId: 'bk_edit' })));
    published.mockClear();
    const res = await as(ADMIN)('PATCH', `/bookings/${created.id}`, { endsOn: '2026-12-15', hoursPerWeek: 8, tentative: true });
    expect(res.status).toBe(200);
    expect(await data<Booking>(res)).toMatchObject({ id: created.id, startsOn: '2026-12-01', endsOn: '2026-12-15', hoursPerWeek: '8.00', tentative: true });
    expect(actions()).toEqual(['resource_booking.updated']);

    const earlier = await as(ADMIN)('PATCH', `/bookings/${created.id}`, { endsOn: '2026-11-30' });
    expect(earlier.status).toBe(400);
    expect((await errorOf(earlier)).message).toBe('The end date cannot be before the start date');
    const target = await as(ADMIN)('PATCH', `/bookings/${created.id}`, { projectId: 'prj_cap_b' });
    expect(target.status).toBe(400);
    expect((await as(ADMIN)('PATCH', '/bookings/bkg_nowhere', { hoursPerWeek: 4 })).status).toBe(404);
    expect((await as(MEMBER)('PATCH', `/bookings/${created.id}`, { hoursPerWeek: 4 })).status).toBe(403);
    expect((await as(PM)('PATCH', `/bookings/${created.id}`, { hoursPerWeek: 4 })).status).toBe(200);
  });

  it('keeps a held booking tentative', async () => {
    const held = await data<Booking>(
      await as(ADMIN)('POST', '/bookings', booking({ memberId: 'bk_held', projectId: undefined, requestId: 'prq_cap_hold', tentative: true })),
    );
    const res = await as(ADMIN)('PATCH', `/bookings/${held.id}`, { tentative: false });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('A booking held for a request is always tentative');
  });

  it('deletes a booking and publishes deleted', async () => {
    const created = await data<Booking>(await as(ADMIN)('POST', '/bookings', booking({ memberId: 'bk_del' })));
    published.mockClear();
    expect((await as(MEMBER)('DELETE', `/bookings/${created.id}`)).status).toBe(403);
    const res = await as(PM)('DELETE', `/bookings/${created.id}`);
    expect(res.status).toBe(204);
    expect(actions()).toEqual(['resource_booking.deleted']);
    expect((await as(ADMIN)('GET', '/bookings?memberId=bk_del').then((r) => r.json()) as { data: unknown[] }).data).toEqual([]);
    expect((await as(ADMIN)('DELETE', `/bookings/${created.id}`)).status).toBe(404);
  });
});

// ── Resource requests ───────────────────────────────────────────────────────

describe('resource requests', () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    projectId: 'prj_cap_a',
    skill: 'Frontend',
    hoursPerWeek: 24,
    startsOn: '2026-11-16',
    endsOn: '2026-12-18',
    ...extra,
  });
  const create = async (who: Send = as(PM), extra: Record<string, unknown> = {}) => {
    const res = await who('POST', '/requests', request(extra));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return data<ResourceRequest>(res);
  };

  it('asks for a skill, hours per week and a period, and publishes created', async () => {
    const created = await create();
    expect(created).toMatchObject({
      projectId: 'prj_cap_a',
      projectName: 'Alpha',
      skill: 'Frontend',
      hoursPerWeek: '24.00',
      startsOn: '2026-11-16',
      endsOn: '2026-12-18',
      status: 'open',
      bookingId: null,
    });
    expect(created.id).toMatch(/^rrq_/);
    expect(events()).toEqual([
      {
        entityType: 'resource_request',
        action: 'created',
        entityId: minted(created.id),
        data: expect.objectContaining({ id: minted(created.id), projectId: 'prj_cap_a', skill: 'Frontend', status: 'open' }),
      },
    ]);
    expect(events()[0].data).not.toHaveProperty('projectName');
  });

  it('is for a manager of the project or portfolio:manage', async () => {
    expect((await as(MEMBER)('POST', '/requests', request())).status).toBe(403);
    const beta = await as(PM)('POST', '/requests', request({ projectId: 'prj_cap_b' }));
    expect(beta.status).toBe(403);
    expect((await errorOf(beta)).message).toBe('You do not have permission to request people for this project');
    expect((await as(ADMIN)('POST', '/requests', request({ projectId: 'prj_cap_b' }))).status).toBe(201);
    expect((await as(ADMIN)('POST', '/requests', request({ projectId: 'prj_nowhere' }))).status).toBe(404);
    expect((await as(ADMIN)('POST', '/requests', request({ skill: '  ' }))).status).toBe(400);
    expect((await as(ADMIN)('POST', '/requests', request({ endsOn: '2026-11-01' }))).status).toBe(400);
  });

  it('lists requests with the project name the caller may see', async () => {
    await create(as(ADMIN), { projectId: 'prj_cap_b', skill: 'Design' });
    const res = await as(MEMBER)('GET', '/requests?status=open');
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: ResourceRequest[] }).data;
    const names = new Map(rows.map((r) => [r.projectId, r.projectName]));
    expect(names.get('prj_cap_a')).toBe('Alpha');
    expect(names.get('prj_cap_b')).toBe('Other project');
    const forProject = ((await (await as(ADMIN)('GET', '/requests?projectId=prj_cap_b')).json()) as { data: ResourceRequest[] }).data;
    expect(forProject.every((r) => r.projectId === 'prj_cap_b')).toBe(true);
    expect((await as(OUTSIDER)('GET', '/requests')).status).toBe(403);
    expect((await as(ADMIN)('GET', '/requests?status=pending')).status).toBe(400);
  });

  it('edits an open request, cancels it, and refuses to touch one that is not open', async () => {
    const created = await create();
    published.mockClear();
    const edited = await as(PM)('PATCH', `/requests/${created.id}`, { hoursPerWeek: 16, endsOn: '2026-12-11' });
    expect(edited.status).toBe(200);
    expect(await data<ResourceRequest>(edited)).toMatchObject({ hoursPerWeek: '16.00', endsOn: '2026-12-11', status: 'open' });
    expect(actions()).toEqual(['resource_request.updated']);
    const reversed = await as(PM)('PATCH', `/requests/${created.id}`, { endsOn: '2026-11-01' });
    expect(reversed.status).toBe(400);
    expect((await as(MEMBER)('PATCH', `/requests/${created.id}`, { hoursPerWeek: 8 })).status).toBe(403);
    expect((await as(PM)('PATCH', '/requests/rrq_nowhere', { hoursPerWeek: 8 })).status).toBe(404);
    expect((await as(PM)('PATCH', `/requests/${created.id}`, { status: 'booked' })).status).toBe(400);

    const cancelled = await as(PM)('PATCH', `/requests/${created.id}`, { status: 'cancelled' });
    expect(await data<ResourceRequest>(cancelled)).toMatchObject({ status: 'cancelled' });
    const again = await as(PM)('PATCH', `/requests/${created.id}`, { hoursPerWeek: 8 });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Only an open resource request can be changed');
  });

  it('deletes a request and publishes deleted', async () => {
    const created = await create();
    published.mockClear();
    expect((await as(MEMBER)('DELETE', `/requests/${created.id}`)).status).toBe(403);
    expect((await as(PM)('DELETE', `/requests/${created.id}`)).status).toBe(204);
    expect(actions()).toEqual(['resource_request.deleted']);
    expect((await as(PM)('DELETE', `/requests/${created.id}`)).status).toBe(404);
  });
});

// ── Suggestions and booking a request ───────────────────────────────────────

describe('suggestions and book', () => {
  beforeAll(async () => {
    await db.insert(schema.flowMemberProfiles).values([
      { id: 'fmp_sg_1', memberId: 'sg_joris', weeklyHours: '32.00', skills: ['SgWeb', 'React'], createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'fmp_sg_2', memberId: 'sg_fleur', weeklyHours: '40.00', skills: ['sgweb'], createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'fmp_sg_3', memberId: 'sg_sem', weeklyHours: '32.00', skills: ['Backend'], createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.resourceBookings).values([
      // Joris has 13 hours booked and Fleur 40: 19 and 0 free.
      { id: 'bkg_sg_1', memberId: 'sg_joris', projectId: 'prj_cap_b', startsOn: '2027-02-01', endsOn: '2027-02-28', hoursPerWeek: '13.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now },
      { id: 'bkg_sg_2', memberId: 'sg_fleur', projectId: 'prj_cap_b', startsOn: '2027-02-01', endsOn: '2027-02-28', hoursPerWeek: '40.00', tentative: false, createdBy: ADMIN, createdAt: now, updatedAt: now },
    ]);
  });

  const open = async (extra: Record<string, unknown> = {}) => {
    const res = await as(PM)('POST', '/requests', {
      projectId: 'prj_cap_a',
      skill: 'sgweb',
      hoursPerWeek: 24,
      startsOn: '2027-02-08',
      endsOn: '2027-02-19',
      ...extra,
    });
    expect(res.status).toBe(201);
    return data<ResourceRequest>(res);
  };

  it('suggests the people with the skill by the hours they have free in every week', async () => {
    const created = await open();
    const res = await as(READER)('GET', `/requests/${created.id}/suggestions`);
    expect(res.status).toBe(200);
    const body = await data<{
      request: ResourceRequest;
      suggestions: Array<{ memberId: string; freeHoursPerWeek: number; averageFreeHoursPerWeek: number; coversRequest: boolean; weeklyHours: number }>;
      totalFreeHoursPerWeek: number;
      truncated: boolean;
    }>(res);
    expect(body.request.id).toBe(created.id);
    expect(body.suggestions.map((s) => [s.memberId, s.freeHoursPerWeek, s.averageFreeHoursPerWeek, s.coversRequest])).toEqual([
      ['sg_joris', 19, 19, false],
      ['sg_fleur', 0, 0, false],
    ]);
    // Nobody has 24 hours free on their own; the two together have 19.
    expect(body.totalFreeHoursPerWeek).toBe(19);
    expect(body.truncated).toBe(false);
    expect((await as(OUTSIDER)('GET', `/requests/${created.id}/suggestions`)).status).toBe(403);
    expect((await as(READER)('GET', '/requests/rrq_nowhere/suggestions')).status).toBe(404);
  });

  it('puts people who cover the whole request first', async () => {
    const created = await open({ hoursPerWeek: 16 });
    const body = await data<{ suggestions: Array<{ memberId: string; coversRequest: boolean }> }>(
      await as(ADMIN)('GET', `/requests/${created.id}/suggestions`),
    );
    expect(body.suggestions.map((s) => [s.memberId, s.coversRequest])).toEqual([
      ['sg_joris', true],
      ['sg_fleur', false],
    ]);
    const nobody = await open({ skill: 'Security' });
    expect((await data<{ suggestions: unknown[] }>(await as(ADMIN)('GET', `/requests/${nobody.id}/suggestions`))).suggestions).toEqual([]);
  });

  it('books a person on the request, firm or tentative: a booking, and the request is booked', async () => {
    const created = await open();
    published.mockClear();
    const res = await as(PM)('POST', `/requests/${created.id}/book`, { memberId: 'sg_joris', tentative: true });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const body = await data<{ booking: Booking; request: ResourceRequest }>(res);
    expect(body.booking).toMatchObject({
      memberId: 'sg_joris',
      projectId: 'prj_cap_a',
      requestId: null,
      startsOn: '2027-02-08',
      endsOn: '2027-02-19',
      hoursPerWeek: '24.00',
      tentative: true,
    });
    expect(body.request).toMatchObject({ id: created.id, status: 'booked', bookingId: body.booking.id });
    expect(actions()).toEqual(['resource_booking.created', 'resource_request.updated']);

    const again = await as(PM)('POST', `/requests/${created.id}/book`, { memberId: 'sg_fleur' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This resource request is no longer open');

    // The hours count in the load, tentative ones when asked for.
    const loaded = await load(as(ADMIN), 'from=2027-02-08&to=2027-02-14&tentative=true');
    expect(hours(loaded, 'sg_joris')).toEqual([37]);
    expect(hours(await load(as(ADMIN), 'from=2027-02-08&to=2027-02-14'), 'sg_joris')).toEqual([13]);

    // Deleting the booking opens the request again.
    published.mockClear();
    expect((await as(PM)('DELETE', `/bookings/${body.booking.id}`)).status).toBe(204);
    expect(actions()).toEqual(['resource_booking.deleted', 'resource_request.updated']);
    const [reopened] = ((await (await as(ADMIN)('GET', `/requests?projectId=prj_cap_a&status=open`)).json()) as { data: ResourceRequest[] }).data.filter(
      (r) => r.id === created.id,
    );
    expect(reopened).toMatchObject({ status: 'open', bookingId: null });
  });

  it('checks who may book, the body and the request', async () => {
    const created = await open();
    const send = as(PM);
    expect((await as(MEMBER)('POST', `/requests/${created.id}/book`, { memberId: 'sg_joris' })).status).toBe(403);
    // A member may book themselves on a request of a project they can write to.
    expect((await send('POST', '/requests/rrq_nowhere/book', { memberId: 'sg_joris' })).status).toBe(404);
    const noMember = await send('POST', `/requests/${created.id}/book`, {});
    expect(noMember.status).toBe(400);
    expect((await errorOf(noMember)).message).toBe('Invalid request body');
    expect((await send('POST', `/requests/${created.id}/book`, { memberId: 'sg_joris', extra: 1 })).status).toBe(400);
    const cancelled = await open();
    await send('PATCH', `/requests/${cancelled.id}`, { status: 'cancelled' });
    expect((await send('POST', `/requests/${cancelled.id}/book`, { memberId: 'sg_joris' })).status).toBe(409);
    // Firm booking by portfolio:manage.
    const firm = await as(ADMIN)('POST', `/requests/${created.id}/book`, { memberId: 'sg_fleur' });
    expect(firm.status).toBe(201);
    expect((await data<{ booking: Booking }>(firm)).booking.tentative).toBe(false);
  });
});

// ── Profiles ────────────────────────────────────────────────────────────────

describe('member profiles', () => {
  type Profile = { memberId: string; weeklyHours: number; skills: string[]; hasProfile: boolean; updatedAt: string | null };

  it('answers the defaults for a member without a profile', async () => {
    const res = await as(READER)('GET', '/profiles/pf_nobody');
    expect(res.status).toBe(200);
    expect(await data<Profile>(res)).toEqual({ memberId: 'pf_nobody', weeklyHours: 40, skills: [], hasProfile: false, updatedAt: null });
    expect((await as(OUTSIDER)('GET', '/profiles/pf_nobody')).status).toBe(403);
  });

  it('lets a member set their own hours and skills, keeping each skill once, and publishes updated', async () => {
    const res = await as(MEMBER)('PUT', `/profiles/${MEMBER}`, { weeklyHours: 32, skills: [' Backend ', 'backend', 'QA'] });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await data<Profile>(res)).toMatchObject({ memberId: MEMBER, weeklyHours: 32, skills: ['Backend', 'QA'], hasProfile: true });
    expect(events()).toEqual([
      {
        entityType: 'flow_member_profile',
        action: 'updated',
        entityId: expect.stringMatching(/^fmp_/),
        data: expect.objectContaining({ memberId: MEMBER, weeklyHours: 32, skills: ['Backend', 'QA'], hasProfile: true }),
      },
    ]);
    const [row] = await db.select().from(schema.flowMemberProfiles).where(eq(schema.flowMemberProfiles.memberId, MEMBER));
    expect(row.weeklyHours).toBe('32.00');
  });

  it('changes only the fields given', async () => {
    await as(ADMIN)('PUT', '/profiles/pf_part', { weeklyHours: 24, skills: ['Design'] });
    const onlySkills = await as(ADMIN)('PUT', '/profiles/pf_part', { skills: ['Design', 'UX'] });
    expect(await data<Profile>(onlySkills)).toMatchObject({ weeklyHours: 24, skills: ['Design', 'UX'] });
    const onlyHours = await as(ADMIN)('PUT', '/profiles/pf_part', { weeklyHours: 16 });
    expect(await data<Profile>(onlyHours)).toMatchObject({ weeklyHours: 16, skills: ['Design', 'UX'] });
    // A first save with only skills starts at 40 hours.
    const fresh = await as(ADMIN)('PUT', '/profiles/pf_fresh', { skills: ['PM'] });
    expect(await data<Profile>(fresh)).toMatchObject({ weeklyHours: 40, skills: ['PM'], hasProfile: true });
    const listed = ((await (await as(READER)('GET', '/profiles')).json()) as { data: Profile[] }).data;
    expect(listed.find((p) => p.memberId === 'pf_part')).toMatchObject({ weeklyHours: 16, hasProfile: true });
    expect(listed.map((p) => p.memberId)).toEqual([...listed.map((p) => p.memberId)].sort());
  });

  it('is for portfolio:manage or the member themselves', async () => {
    const other = await as(MEMBER)('PUT', '/profiles/pf_someone', { weeklyHours: 20 });
    expect(other.status).toBe(403);
    expect((await errorOf(other)).message).toBe('You can only change your own profile');
    expect((await as(ADMIN)('PUT', '/profiles/pf_someone', { weeklyHours: 20 })).status).toBe(200);
    expect((await as(OUTSIDER)('PUT', `/profiles/${OUTSIDER}`, { weeklyHours: 20 })).status).toBe(403);
  });

  it('refuses bad hours and skills', async () => {
    const send = as(ADMIN);
    for (const body of [{ weeklyHours: 169 }, { weeklyHours: -1 }, { skills: [''] }, { skills: 'Backend' }, { memberId: 'x' }]) {
      const res = await send('PUT', '/profiles/pf_bad', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect((await send('PUT', '/profiles/pf_bad', { weeklyHours: 0 })).status).toBe(200);
  });
});

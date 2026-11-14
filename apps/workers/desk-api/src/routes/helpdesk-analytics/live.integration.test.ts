/**
 * The wallboard and the phone report (GET /wallboard, GET /phone), against
 * pglite. The clock is faked to Sunday 2026-03-15 12:00 UTC: "today" is the
 * 15th, "the last 7 days" is 9 to 15 March and the previous period 2 to 8
 * March. In conformance mode the answers are Rust's, which reads the same
 * clock (CONFORMANCE_NOW).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskPhoneReportSchema, deskWallboardSchema } from '@weldsuite/core-api-client/schemas/helpdesk-live-reports';
import { helpdeskAnalyticsRoutes } from './index';

const BASE = '/api/helpdesk-analytics';
let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskAnalyticsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const t = (day: number, hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 2, day, hour, minute, second));

async function wallboard(query = '') {
  const res = await app('conversations:read').request(`${BASE}/wallboard${query}`);
  expect(res.status).toBe(200);
  const data = ((await res.json()) as { data: unknown }).data;
  return deskWallboardSchema.parse(data);
}

async function phone(range?: string) {
  const res = await app('settings:read').request(`${BASE}/phone${range ? `?range=${range}` : ''}`);
  expect(res.status).toBe(200);
  const data = ((await res.json()) as { data: unknown }).data;
  return deskPhoneReportSchema.parse(data);
}

const conversation = (
  n: number,
  fields: Partial<typeof schema.deskConversations.$inferInsert> & { createdAt: Date },
): typeof schema.deskConversations.$inferInsert => ({
  id: `dconv_live_${n}`,
  conversationNumber: n,
  updatedAt: fields.createdAt,
  lastMessageAt: fields.createdAt,
  ...fields,
});

const call = (
  id: string,
  enteredAt: Date | null,
  fields: Partial<typeof schema.voipCalls.$inferInsert> = {},
): typeof schema.voipCalls.$inferInsert => ({
  id: `vcall_live_${id}`,
  userId: 'user_ann',
  direction: 'inbound',
  fromNumber: '+31600000000',
  toNumber: '+31200000000',
  initiatedAt: enteredAt ?? t(15, 8),
  queueEnteredAt: enteredAt,
  ...fields,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t(15, 12));
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_live_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com' },
    { id: 'wm_live_bob', userId: 'user_bob', name: 'Bob', email: 'bob@example.com' },
    { id: 'wm_live_cy', userId: 'user_cy', name: 'Cy', email: 'cy@example.com', memberType: 'EXTERNAL_GUEST' },
    { id: 'wm_live_dee', userId: 'user_dee', name: 'Dee', email: 'dee@example.com', status: 'SUSPENDED' },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dep_live_billing', name: 'Billing' },
    { id: 'dep_live_tech', name: 'Tech' },
    { id: 'dep_live_old', name: 'Retired', isActive: false },
  ]);
  await db.insert(schema.helpdeskSettings).values({
    id: 'hds_live_1',
    automation: { enabled: false, deskAssignment: { mode: 'off', memberIds: [], awayMemberIds: ['user_bob'], maxOpenPerMember: null } },
  });

  await db.insert(schema.deskConversations).values([
    // Open, Billing, Ann's, waiting an hour, SLA at risk; opened and answered today.
    conversation(1, {
      createdAt: t(15, 8),
      name: 'Alpha',
      departmentId: 'dep_live_billing',
      assigneeId: 'user_ann',
      waitingSince: t(15, 11),
      slaStatus: 'warning',
      slaDueAt: t(15, 12, 30),
      slaMetric: 'first_response',
      firstResponseAt: t(15, 8, 30),
      firstResponseSeconds: 1800,
    }),
    // Open, Billing, unassigned, waiting three hours, SLA breached.
    conversation(2, {
      createdAt: t(14, 9),
      name: 'Bravo',
      departmentId: 'dep_live_billing',
      waitingSince: t(15, 9),
      slaStatus: 'breached',
      slaDueAt: t(15, 11),
      slaMetric: 'resolution',
    }),
    // Open, Tech, Bob's (away), the ball is with the customer, SLA running.
    conversation(3, {
      createdAt: t(14, 10),
      name: 'Charlie',
      departmentId: 'dep_live_tech',
      assigneeId: 'user_bob',
      slaStatus: 'active',
      slaDueAt: t(15, 15),
      slaMetric: 'resolution',
    }),
    // Open, no team, unassigned, waiting ten minutes, SLA paused (not due soon); opened and answered today.
    conversation(4, {
      createdAt: t(15, 10),
      name: 'Delta',
      waitingSince: t(15, 11, 50),
      slaStatus: 'paused',
      slaDueAt: t(15, 11),
      slaMetric: 'first_response',
      firstResponseAt: t(15, 10, 10),
      firstResponseSeconds: 600,
    }),
    // Closed today.
    conversation(5, {
      createdAt: t(15, 7),
      state: 'closed',
      name: 'Echo',
      departmentId: 'dep_live_billing',
      resolvedAt: t(15, 9),
      slaStatus: 'achieved',
    }),
    // A merged duplicate: counted nowhere.
    conversation(6, {
      createdAt: t(15, 9),
      name: 'Foxtrot',
      departmentId: 'dep_live_billing',
      waitingSince: t(15, 9),
      slaStatus: 'breached',
      slaDueAt: t(15, 10),
      mergedIntoId: 'dconv_live_1',
    }),
    // Open in a team that is switched off: in the queue, in no team row.
    conversation(7, {
      createdAt: t(14, 8),
      name: 'Golf',
      departmentId: 'dep_live_old',
      assigneeId: 'user_ann',
    }),
  ]);

  await db.insert(schema.deskPhoneAgents).values([
    { userId: 'user_ann', available: true },
    { userId: 'user_bob', available: false },
    { userId: 'user_cy', available: true },
  ]);

  await db.insert(schema.voipCalls).values([
    // This period: answered after 30 s, handled 5 min (Billing).
    call('c1', t(15, 9), {
      departmentId: 'dep_live_billing',
      outcome: 'answered',
      answeredByUserId: 'user_ann',
      agentAnsweredAt: t(15, 9, 0, 30),
      endedAt: t(15, 9, 5, 30),
    }),
    // Answered after 60 s, handled 10 min (general queue).
    call('c2', t(15, 9, 30), {
      outcome: 'answered',
      answeredByUserId: 'user_ann',
      agentAnsweredAt: t(15, 9, 31),
      endedAt: t(15, 9, 41),
    }),
    // Abandoned after 45 s (Billing).
    call('c3', t(15, 7), { departmentId: 'dep_live_billing', outcome: 'abandoned', endedAt: t(15, 7, 0, 45) }),
    // Missed (Tech), on the 13th.
    call('c4', t(13, 10), { departmentId: 'dep_live_tech', outcome: 'missed', endedAt: t(13, 10, 0, 30) }),
    // Voicemail after a minute (Tech).
    call('c5', t(15, 8), { departmentId: 'dep_live_tech', outcome: 'voicemail', endedAt: t(15, 8, 1) }),
    // Still waiting, two minutes (Billing).
    call('c6', t(15, 11, 58), { departmentId: 'dep_live_billing' }),
    // Bob answered after two minutes, handled 10 min (Tech), on the 10th.
    call('c7', t(10, 9), {
      departmentId: 'dep_live_tech',
      userId: 'user_bob',
      outcome: 'answered',
      answeredByUserId: 'user_bob',
      agentAnsweredAt: t(10, 9, 2),
      endedAt: t(10, 9, 12),
    }),
    // An outbound call never reached the queue.
    call('c8', null, { direction: 'outbound', endedAt: t(15, 8, 5) }),
    // The period before: answered after 10 s, handled a minute (Billing).
    call('p1', t(5, 10), {
      departmentId: 'dep_live_billing',
      outcome: 'answered',
      answeredByUserId: 'user_ann',
      agentAnsweredAt: t(5, 10, 0, 10),
      endedAt: t(5, 10, 1, 10),
    }),
    // Abandoned after 20 s (Billing).
    call('p2', t(6, 11), { departmentId: 'dep_live_billing', outcome: 'abandoned', endedAt: t(6, 11, 0, 20) }),
    // Missed after 40 s (Tech).
    call('p3', t(7, 12), { departmentId: 'dep_live_tech', outcome: 'missed', endedAt: t(7, 12, 0, 40) }),
  ]);
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('wallboard', () => {
  it('needs conversations:read, and settings:read is not enough', async () => {
    expect((await app('settings:read').request(`${BASE}/wallboard`)).status).toBe(403);
    expect((await app().request(`${BASE}/wallboard`)).status).toBe(403);
  });

  it('answers the queue, SLA risk, today, teams and agents, leaving merged duplicates out', async () => {
    const data = await wallboard();
    expect(data.generatedAt).toBe('2026-03-15T12:00:00.000Z');
    expect(data.queue).toEqual({ open: 5, unassigned: 2, waiting: 3, oldestWaitingSeconds: 10_800 });
    expect(data.sla.breached).toBe(1);
    expect(data.sla.atRisk).toBe(1);
    expect(data.today).toEqual({ created: 3, resolved: 1, firstResponseMedianSeconds: 1200 });
  });

  it('lists the conversations due soonest, without paused or achieved clocks', async () => {
    const { sla } = await wallboard();
    expect(sla.dueSoon).toEqual([
      {
        conversationId: 'dconv_live_2',
        conversationNumber: 2,
        name: 'Bravo',
        dueAt: '2026-03-15T11:00:00.000Z',
        metric: 'resolution',
        status: 'breached',
        assigneeName: null,
      },
      {
        conversationId: 'dconv_live_1',
        conversationNumber: 1,
        name: 'Alpha',
        dueAt: '2026-03-15T12:30:00.000Z',
        metric: 'first_response',
        status: 'warning',
        assigneeName: 'Ann',
      },
      {
        conversationId: 'dconv_live_3',
        conversationNumber: 3,
        name: 'Charlie',
        dueAt: '2026-03-15T15:00:00.000Z',
        metric: 'resolution',
        status: 'active',
        assigneeName: 'Bob',
      },
    ]);
  });

  it('counts per active team and per active internal member, with the away switch', async () => {
    const data = await wallboard();
    expect(data.teams).toEqual([
      { id: 'dep_live_billing', name: 'Billing', open: 2, unassigned: 1, waiting: 2, breached: 1 },
      { id: 'dep_live_tech', name: 'Tech', open: 1, unassigned: 0, waiting: 0, breached: 0 },
    ]);
    expect(data.agents).toEqual([
      { id: 'user_ann', name: 'Ann', open: 2, away: false },
      { id: 'user_bob', name: 'Bob', open: 1, away: true },
    ]);
  });

  it('narrows everything to one team, and refuses an unknown one', async () => {
    const data = await wallboard('?teamId=dep_live_billing');
    expect(data.queue).toEqual({ open: 2, unassigned: 1, waiting: 2, oldestWaitingSeconds: 10_800 });
    expect(data.sla).toMatchObject({ breached: 1, atRisk: 1 });
    expect(data.sla.dueSoon.map((d) => d.conversationNumber)).toEqual([2, 1]);
    expect(data.today).toEqual({ created: 2, resolved: 1, firstResponseMedianSeconds: 1800 });
    expect(data.teams.map((x) => x.id)).toEqual(['dep_live_billing']);
    expect(data.agents).toEqual([
      { id: 'user_ann', name: 'Ann', open: 1, away: false },
      { id: 'user_bob', name: 'Bob', open: 0, away: true },
    ]);

    const tech = await wallboard('?teamId=dep_live_tech');
    expect(tech.queue).toEqual({ open: 1, unassigned: 0, waiting: 0, oldestWaitingSeconds: null });

    const res = await app('conversations:read').request(`${BASE}/wallboard?teamId=dep_nope`);
    expect(res.status).toBe(400);
  });

  it('has no phone block while no route sends calls to agents', async () => {
    expect((await wallboard()).phone).toBeNull();
    await db.insert(schema.deskPhoneRoutes).values({ id: 'dpr_live_1', voipPhoneNumberId: 'vpn_live_1', action: 'forward' });
    expect((await wallboard()).phone).toBeNull();
  });

  it('answers the phone queue once a route rings agents (a menu counts too)', async () => {
    await db.insert(schema.deskPhoneRoutes).values({ id: 'dpr_live_2', voipPhoneNumberId: 'vpn_live_2', action: 'menu' });
    const data = await wallboard();
    expect(data.phone).toEqual({
      waiting: 1,
      longestWaitSeconds: 120,
      availableAgents: 2,
      answeredToday: 2,
      missedToday: 1,
      abandonedToday: 1,
    });
    expect((await wallboard('?teamId=dep_live_billing')).phone).toEqual({
      waiting: 1,
      longestWaitSeconds: 120,
      availableAgents: 2,
      answeredToday: 1,
      missedToday: 0,
      abandonedToday: 1,
    });
    expect((await wallboard('?teamId=dep_live_tech')).phone).toEqual({
      waiting: 0,
      longestWaitSeconds: null,
      availableAgents: 2,
      answeredToday: 0,
      missedToday: 1,
      abandonedToday: 0,
    });
  });
});

describe('phone report', () => {
  it('needs settings:read', async () => {
    expect((await app('conversations:read').request(`${BASE}/phone`)).status).toBe(403);
  });

  it('answers the KPIs of the last 7 days against the 7 before', async () => {
    const data = await phone('last_7_days');
    expect(data).toMatchObject({ range: 'last_7_days', start: '2026-03-09', end: '2026-03-16', bucket: 'day' });
    expect(data.kpis).toEqual({
      offered: { value: 7, previous: 3 },
      answered: { value: 3, previous: 1 },
      missed: { value: 1, previous: 1 },
      abandoned: { value: 1, previous: 1 },
      voicemail: { value: 1, previous: 0 },
      answerRate: { value: 42.9, previous: 33.3 },
      waitAvg: { value: 70, previous: 10 },
      waitMedian: { value: 60, previous: 10 },
      abandonAvg: { value: 45, previous: 20 },
      handleAvg: { value: 500, previous: 60 },
      handleMedian: { value: 600, previous: 60 },
      longestWait: { value: 120, previous: 40 },
    });
  });

  it('answers a series with every day of the period, zeros included', async () => {
    const { series } = await phone('last_7_days');
    expect(series).toEqual([
      { date: '2026-03-09', offered: 0, answered: 0, missed: 0, abandoned: 0 },
      { date: '2026-03-10', offered: 1, answered: 1, missed: 0, abandoned: 0 },
      { date: '2026-03-11', offered: 0, answered: 0, missed: 0, abandoned: 0 },
      { date: '2026-03-12', offered: 0, answered: 0, missed: 0, abandoned: 0 },
      { date: '2026-03-13', offered: 1, answered: 0, missed: 1, abandoned: 0 },
      { date: '2026-03-14', offered: 0, answered: 0, missed: 0, abandoned: 0 },
      { date: '2026-03-15', offered: 5, answered: 2, missed: 0, abandoned: 1 },
    ]);
  });

  it('breaks the period down by agent, team and UTC hour', async () => {
    const data = await phone('last_7_days');
    expect(data.agents).toEqual([
      { id: 'user_ann', name: 'Ann', answered: 2, handleAvg: 450, handleTotal: 900 },
      { id: 'user_bob', name: 'Bob', answered: 1, handleAvg: 600, handleTotal: 600 },
    ]);
    expect(data.teams).toEqual([
      { id: 'dep_live_billing', name: 'Billing', offered: 3, answered: 1, missed: 0, abandoned: 1, waitAvg: 30 },
      { id: 'dep_live_tech', name: 'Tech', offered: 3, answered: 1, missed: 1, abandoned: 0, waitAvg: 120 },
      { id: null, name: null, offered: 1, answered: 1, missed: 0, abandoned: 0, waitAvg: 60 },
    ]);
    expect(data.hours).toHaveLength(24);
    expect(data.hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    const busy = data.hours.filter((h) => h.offered > 0);
    expect(busy).toEqual([
      { hour: 7, offered: 1, answered: 0 },
      { hour: 8, offered: 1, answered: 0 },
      { hour: 9, offered: 3, answered: 3 },
      { hour: 10, offered: 1, answered: 0 },
      { hour: 11, offered: 1, answered: 0 },
    ]);
  });

  it('answers a quiet period with zero rows and empty durations', async () => {
    const data = await phone('yesterday');
    expect(data).toMatchObject({ start: '2026-03-14', end: '2026-03-15' });
    // The day before (the 13th) had one missed call.
    expect(data.kpis.offered).toEqual({ value: 0, previous: 1 });
    expect(data.kpis.answerRate).toEqual({ value: null, previous: 0 });
    expect(data.kpis.waitAvg).toEqual({ value: null, previous: null });
    expect(data.kpis.longestWait).toEqual({ value: null, previous: 30 });
    expect(data.series).toEqual([{ date: '2026-03-14', offered: 0, answered: 0, missed: 0, abandoned: 0 }]);
    expect(data.agents).toEqual([]);
    expect(data.teams).toEqual([]);
    expect(data.hours).toHaveLength(24);
  });

  it('goes back to the first call for all time, and falls back to 30 days', async () => {
    const all = await phone('all_time');
    expect(all).toMatchObject({ range: 'all_time', start: '2026-03-05', end: '2026-03-16' });
    expect(all.kpis.offered.value).toBe(10);
    expect((await phone('nonsense')).range).toBe('last_30_days');
    expect((await phone()).range).toBe('last_30_days');
  });
});

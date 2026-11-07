/**
 * WeldDesk reports on the live inbox (ADR DESK-011), against pglite: the
 * overview and the report builder's chart data, aggregated from
 * desk_conversations, desk_messages and desk_sla_clocks.
 *
 * The clock is faked to Sunday 2026-03-15 12:00 UTC, so "the last 7 days" is
 * 9 to 15 March and the previous period 2 to 8 March. In conformance mode
 * the answers are Rust's, which reads the same clock (CONFORMANCE_NOW).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskAnalyticsRoutes } from './index';

const BASE = '/api/helpdesk-analytics';
let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskAnalyticsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const t = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 2, day, hour, minute));

async function overview(range?: string) {
  const res = await app('settings:read').request(`${BASE}/overview${range ? `?range=${range}` : ''}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

async function chart(metric: string, extra: Record<string, unknown> = {}) {
  const res = await app('settings:read').request(`${BASE}/charts/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity: 'tickets',
      metric,
      timeRange: 'last_7_days',
      groupBy: 'day',
      aggregation: 'sum',
      ...extra,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<{ label: string; value: number }> }).data;
}

const conversation = (
  n: number,
  fields: Partial<typeof schema.deskConversations.$inferInsert> & { createdAt: Date },
): typeof schema.deskConversations.$inferInsert => ({
  id: `dconv_rpt_${n}`,
  conversationNumber: n,
  updatedAt: fields.createdAt,
  lastMessageAt: fields.createdAt,
  ...fields,
});

const clock = (
  id: string,
  conversationId: string,
  metric: 'first_response' | 'resolution',
  startedAt: Date,
  fields: Partial<typeof schema.deskSlaClocks.$inferInsert>,
): typeof schema.deskSlaClocks.$inferInsert => ({
  id,
  conversationId,
  metric,
  targetMinutes: 60,
  status: 'completed',
  startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
  ...fields,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t(15, 12));
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_rpt_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com' },
    { id: 'wm_rpt_bob', userId: 'user_bob', name: 'Bob', email: 'bob@example.com' },
  ]);
  await db.insert(schema.helpdeskDepartments).values({ id: 'dep_rpt_billing', name: 'Billing' });
  await db.insert(schema.helpdeskTicketTypes).values({ id: 'tt_rpt_incident', name: 'Incident' });

  await db.insert(schema.deskConversations).values([
    // This week: answered, resolved and rated 5.
    conversation(1, {
      createdAt: t(10, 9),
      state: 'closed',
      channel: 'email',
      priority: 'high',
      assigneeId: 'user_ann',
      departmentId: 'dep_rpt_billing',
      ticketTypeId: 'tt_rpt_incident',
      visitorId: 'v_rita',
      name: 'Rita',
      firstResponseAt: t(10, 9, 30),
      firstResponseSeconds: 1800,
      resolvedAt: t(10, 13),
      resolutionSeconds: 14_400,
      rating: 5,
      ratedAt: t(10, 14),
    }),
    // This week: answered, now waiting on the team again.
    conversation(2, {
      createdAt: t(11, 10),
      channel: 'messenger',
      assigneeId: 'user_bob',
      visitorId: 'v_sam',
      name: 'Sam',
      firstResponseAt: t(11, 11),
      firstResponseSeconds: 3600,
      waitingSince: t(11, 12),
    }),
    // This week: Rita again, unassigned and unanswered.
    conversation(3, {
      createdAt: t(12, 8),
      channel: 'messenger',
      priority: 'urgent',
      visitorId: 'v_rita',
      name: 'Rita',
      waitingSince: t(12, 8),
    }),
    // Last week, resolved (and rated 2) this week.
    conversation(4, {
      createdAt: t(5, 10),
      state: 'closed',
      channel: 'email',
      priority: 'low',
      assigneeId: 'user_ann',
      departmentId: 'dep_rpt_billing',
      visitorId: 'v_tom',
      name: 'Tom',
      firstResponseAt: t(5, 12),
      firstResponseSeconds: 7200,
      resolvedAt: t(9, 10),
      resolutionSeconds: 345_600,
      rating: 2,
      ratedAt: t(9, 11),
    }),
    // Last week: done within the week, rated 4.
    conversation(5, {
      createdAt: t(3, 10),
      state: 'closed',
      channel: 'phone',
      priority: 'medium',
      assigneeId: 'user_bob',
      visitorId: 'v_uma',
      name: 'Uma',
      firstResponseAt: t(3, 10, 10),
      firstResponseSeconds: 600,
      resolvedAt: t(3, 11),
      resolutionSeconds: 3600,
      rating: 4,
      ratedAt: t(3, 12),
    }),
  ]);

  await db.insert(schema.deskMessages).values([
    { id: 'dmsg_rpt_1', createdAt: t(10, 9, 30), conversationId: 'dconv_rpt_1', kind: 'message', authorType: 'agent', authorId: 'user_ann', body: 'Hi' },
    { id: 'dmsg_rpt_2', createdAt: t(11, 11), conversationId: 'dconv_rpt_2', kind: 'message', authorType: 'agent', authorId: 'user_bob', body: 'Hello' },
    { id: 'dmsg_rpt_3', createdAt: t(11, 11, 5), conversationId: 'dconv_rpt_2', kind: 'message', authorType: 'agent', authorId: 'user_bob', body: 'Also' },
    { id: 'dmsg_rpt_4', createdAt: t(12, 9), conversationId: 'dconv_rpt_3', kind: 'note', authorType: 'agent', authorId: 'user_ann', body: 'A note is no reply' },
  ]);

  await db.insert(schema.deskSlaClocks).values([
    clock('dsla_rpt_1', 'dconv_rpt_1', 'first_response', t(10, 9), {}),
    clock('dsla_rpt_2', 'dconv_rpt_1', 'resolution', t(10, 9), {}),
    clock('dsla_rpt_3', 'dconv_rpt_3', 'first_response', t(12, 8), { status: 'running', breachedAt: t(12, 9) }),
    clock('dsla_rpt_4', 'dconv_rpt_5', 'first_response', t(3, 10), {}),
  ]);
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('reports overview', () => {
  it('needs settings:read', async () => {
    expect((await app('conversations:read').request(`${BASE}/overview`)).status).toBe(403);
  });

  it('answers the KPIs of the last 7 days against the 7 before', async () => {
    const data = await overview('last_7_days');
    expect(data.range).toEqual({ key: 'last_7_days', start: '2026-03-09', end: '2026-03-16', bucket: 'day' });
    expect(data.kpis).toEqual({
      created: { value: 3, previous: 2 },
      resolved: { value: 2, previous: 1 },
      firstResponseAvg: { value: 2700, previous: 3900 },
      firstResponseMedian: { value: 2700, previous: 3900 },
      resolutionAvg: { value: 180_000, previous: 3600 },
      resolutionMedian: { value: 180_000, previous: 3600 },
      slaCompliance: { value: 66.7, previous: 100 },
      csat: { value: 50, previous: 100 },
    });
    expect(data.backlog).toEqual({ open: 2, unassigned: 1, waiting: 2 });
    expect(data.counts).toEqual({
      firstResponses: 2,
      resolutions: 2,
      slaMet: 2,
      slaBreached: 1,
      ratings: 2,
      ratingAverage: 3.5,
    });
  });

  it('answers a series per day, with every day of the period', async () => {
    const data = await overview('last_7_days');
    expect(data.series).toEqual([
      { label: '2026-03-09', created: 0, resolved: 1, firstResponseAvg: null, resolutionAvg: 345_600 },
      { label: '2026-03-10', created: 1, resolved: 1, firstResponseAvg: 1800, resolutionAvg: 14_400 },
      { label: '2026-03-11', created: 1, resolved: 0, firstResponseAvg: 3600, resolutionAvg: null },
      { label: '2026-03-12', created: 1, resolved: 0, firstResponseAvg: null, resolutionAvg: null },
      { label: '2026-03-13', created: 0, resolved: 0, firstResponseAvg: null, resolutionAvg: null },
      { label: '2026-03-14', created: 0, resolved: 0, firstResponseAvg: null, resolutionAvg: null },
      { label: '2026-03-15', created: 0, resolved: 0, firstResponseAvg: null, resolutionAvg: null },
    ]);
  });

  it('breaks the period down by channel, priority, agent and team', async () => {
    const data = await overview('last_7_days');
    expect(data.byChannel).toEqual([
      { key: 'messenger', count: 2 },
      { key: 'email', count: 1 },
    ]);
    expect(data.byPriority).toEqual([
      { key: 'high', count: 1 },
      { key: 'none', count: 1 },
      { key: 'urgent', count: 1 },
    ]);
    expect(data.agents).toEqual([
      { id: 'user_ann', name: 'Ann', created: 1, resolved: 2, firstResponseAvg: 1800, resolutionAvg: 180_000, ratings: 2, csat: 50 },
      { id: null, name: '', created: 1, resolved: 0, firstResponseAvg: null, resolutionAvg: null, ratings: 0, csat: null },
      { id: 'user_bob', name: 'Bob', created: 1, resolved: 0, firstResponseAvg: 3600, resolutionAvg: null, ratings: 0, csat: null },
    ]);
    expect(data.teams).toEqual([
      { id: 'dep_rpt_billing', name: 'Billing', created: 1, resolved: 2, firstResponseAvg: 1800, resolutionAvg: 180_000, ratings: 2, csat: 50 },
      { id: null, name: '', created: 2, resolved: 0, firstResponseAvg: 3600, resolutionAvg: null, ratings: 0, csat: null },
    ]);
  });

  it('goes back to the oldest conversation for all time, and falls back to 30 days', async () => {
    const all = await overview('all_time');
    expect(all.range).toEqual({ key: 'all_time', start: '2026-03-03', end: '2026-03-16', bucket: 'day' });
    expect(all.series as unknown[]).toHaveLength(13);
    expect((all.kpis as { created: { value: number } }).created.value).toBe(5);

    const fallback = await overview('next_decade');
    expect(fallback.range).toEqual({ key: 'last_30_days', start: '2026-02-14', end: '2026-03-16', bucket: 'day' });
    const year = await overview('this_year');
    expect(year.range).toEqual({ key: 'this_year', start: '2026-01-01', end: '2026-03-16', bucket: 'day' });
  });
});

describe('report builder chart data', () => {
  it('counts tickets per day, keeping the old metric ids working', async () => {
    const expected = [
      { label: '2026-03-09', value: 0 },
      { label: '2026-03-10', value: 1 },
      { label: '2026-03-11', value: 1 },
      { label: '2026-03-12', value: 1 },
      { label: '2026-03-13', value: 0 },
      { label: '2026-03-14', value: 0 },
      { label: '2026-03-15', value: 0 },
    ];
    expect(await chart('tickets_created')).toEqual(expected);
    expect(await chart('total_tickets', { entity: 'conversations', groupBy: 'month' })).toEqual([
      { label: '2026-03', value: 3 },
    ]);
    expect(await chart('tickets_resolved', { limit: 2, sortOrder: 'desc' })).toEqual([
      { label: '2026-03-15', value: 0 },
      { label: '2026-03-14', value: 0 },
    ]);
  });

  it('groups by a dimension, sorted by value', async () => {
    expect(await chart('tickets_by_priority')).toEqual([
      { label: 'high', value: 1 },
      { label: 'none', value: 1 },
      { label: 'urgent', value: 1 },
    ]);
    expect(await chart('tickets_by_type', { sortOrder: 'desc' })).toEqual([
      { label: '', value: 2 },
      { label: 'Incident', value: 1 },
    ]);
    expect(await chart('agent_response_time', { sortOrder: 'desc' })).toEqual([
      { label: 'Bob', value: 60 },
      { label: 'Ann', value: 30 },
    ]);
    expect(await chart('replies_per_agent', { sortOrder: 'desc' })).toEqual([
      { label: 'Bob', value: 2 },
      { label: 'Ann', value: 1 },
    ]);
    expect(await chart('top_customers', { sortOrder: 'desc', limit: 5 })).toEqual([
      { label: 'Rita', value: 2 },
      { label: 'Sam', value: 1 },
    ]);
  });

  it('averages durations in minutes and hours, and honours max and min', async () => {
    expect(await chart('avg_first_response', { groupBy: 'week' })).toEqual([{ label: '2026-03-09', value: 45 }]);
    expect(await chart('avg_first_response', { groupBy: 'week', aggregation: 'max' })).toEqual([
      { label: '2026-03-09', value: 60 },
    ]);
    expect(await chart('avg_resolution_time', { groupBy: 'week', aggregation: 'min' })).toEqual([
      { label: '2026-03-09', value: 4 },
    ]);
    // Days without a first response are left out of an average.
    expect(await chart('response_time_trend')).toEqual([
      { label: '2026-03-10', value: 30 },
      { label: '2026-03-11', value: 60 },
    ]);
  });

  it('reports satisfaction, SLA compliance and customers', async () => {
    expect(await chart('csat_score', { timeRange: 'last_30_days' })).toEqual([
      { label: '2026-03-03', value: 100 },
      { label: '2026-03-09', value: 0 },
      { label: '2026-03-10', value: 100 },
    ]);
    expect(await chart('ratings_distribution', { timeRange: 'last_30_days' })).toEqual([
      { label: '2', value: 1 },
      { label: '4', value: 1 },
      { label: '5', value: 1 },
    ]);
    expect(await chart('sla_compliance_by_metric')).toEqual([
      { label: 'first_response', value: 50 },
      { label: 'resolution', value: 100 },
    ]);
    const newCustomers = await chart('new_customers');
    expect(newCustomers.filter((p) => p.value > 0)).toEqual([
      { label: '2026-03-10', value: 1 },
      { label: '2026-03-11', value: 1 },
    ]);
    const returning = await chart('returning_customers');
    expect(returning.filter((p) => p.value > 0)).toEqual([{ label: '2026-03-12', value: 1 }]);
  });

  it('answers an empty series for a metric it does not know', async () => {
    expect(await chart('nps_score')).toEqual([]);
  });

  it('answers every chart of a batch by id', async () => {
    const res = await app('settings:read').request(`${BASE}/charts/batch-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        charts: [
          { chartId: 'cht_a', entity: 'tickets', metric: 'tickets_by_channel', timeRange: 'last_7_days', groupBy: 'day', aggregation: 'sum', sortOrder: 'desc' },
          { chartId: 'cht_b', entity: 'satisfaction', metric: 'avg_rating', timeRange: 'last_7_days', groupBy: 'week', aggregation: 'average' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        cht_a: [
          { label: 'messenger', value: 2 },
          { label: 'email', value: 1 },
        ],
        cht_b: [{ label: '2026-03-09', value: 3.5 }],
      },
    });
  });
});

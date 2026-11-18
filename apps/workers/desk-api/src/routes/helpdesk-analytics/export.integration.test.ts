/**
 * CSV export of the reports (TASK-1228), against pglite: the overview as one
 * flat table (`section,label,metric,value,previous`) and a saved report as the
 * points of its charts (`chart,label,value`).
 *
 * The clock is faked to Sunday 2026-03-15 12:00 UTC, so "the last 7 days" is
 * 9 to 15 March, like reports.integration.test.ts.
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

/** The CSV body without its byte order mark, as lines. */
async function lines(res: Response): Promise<string[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The UTF-8 byte order mark (res.text() would strip it).
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(0, -2).split('\r\n');
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t(15, 12));
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_exp_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com' },
    // A name a spreadsheet would run as a formula.
    { id: 'wm_exp_bob', userId: 'user_bob', name: '=HYPERLINK("http://evil")', email: 'bob@example.com' },
  ]);
  await db.insert(schema.deskConversations).values([
    {
      id: 'dconv_exp_1',
      conversationNumber: 1,
      createdAt: t(10, 9),
      updatedAt: t(10, 9),
      lastMessageAt: t(10, 9),
      state: 'closed',
      channel: 'email',
      priority: 'high',
      assigneeId: 'user_ann',
      visitorId: 'v_rita',
      name: 'Rita',
      firstResponseAt: t(10, 9, 30),
      firstResponseSeconds: 1800,
      resolvedAt: t(10, 13),
      resolutionSeconds: 14_400,
      rating: 5,
      ratedAt: t(10, 14),
    },
    {
      id: 'dconv_exp_2',
      conversationNumber: 2,
      createdAt: t(11, 10),
      updatedAt: t(11, 10),
      lastMessageAt: t(11, 10),
      channel: 'messenger',
      assigneeId: 'user_bob',
      visitorId: 'v_sam',
      name: 'Sam',
      firstResponseAt: t(11, 11),
      firstResponseSeconds: 3600,
      waitingSince: t(11, 12),
    },
  ]);

  await db.insert(schema.helpdeskAnalyticsReports).values([
    { id: 'rpt_exp', title: 'Weekly volume / "Q1"', chartCount: 3, createdAt: t(1, 1), updatedAt: t(1, 1) },
    { id: 'rpt_exp_gone', title: 'Gone', chartCount: 0, deletedAt: t(2, 1), createdAt: t(1, 1), updatedAt: t(1, 1) },
    { id: 'rpt_exp_empty', title: '!!!', chartCount: 0, createdAt: t(1, 1), updatedAt: t(1, 1) },
  ]);
  const chart = (id: string, sortIndex: number, title: string, metric: string, extra: Partial<typeof schema.helpdeskAnalyticsCharts.$inferInsert> = {}) => ({
    id,
    reportId: 'rpt_exp',
    title,
    chartType: 'bar-chart',
    entity: 'tickets',
    metric,
    timeRange: 'last_7_days',
    groupBy: 'day',
    aggregation: 'sum',
    layout: { x: 0, y: sortIndex * 4, w: 6, h: 4 },
    sortIndex,
    createdAt: t(1, 2, sortIndex),
    updatedAt: t(1, 2, sortIndex),
    ...extra,
  });
  await db.insert(schema.helpdeskAnalyticsCharts).values([
    chart('cht_exp_2', 2, 'Unknown metric', 'no_such_metric'),
    chart('cht_exp_0', 0, 'By channel', 'tickets_by_channel'),
    chart('cht_exp_1', 1, 'Created per day, "daily"', 'tickets_created_by_day'),
    chart('cht_exp_gone', 3, 'Deleted chart', 'tickets_by_channel', { deletedAt: t(2, 1) }),
  ]);
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('GET /overview/export', () => {
  it('needs settings:read', async () => {
    expect((await app('conversations:read').request(`${BASE}/overview/export`)).status).toBe(403);
  });

  it('answers a CSV download named after the range and the day', async () => {
    const res = await app('settings:read').request(`${BASE}/overview/export?range=last_7_days`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="welddesk-overview-last_7_days-2026-03-15.csv"',
    );
  });

  it('writes the header, the period, the KPIs with their previous values, the backlog and the breakdowns', async () => {
    const rows = await lines(await app('settings:read').request(`${BASE}/overview/export?range=last_7_days`));
    expect(rows[0]).toBe('section,label,metric,value,previous');
    expect(rows.slice(1, 4)).toEqual([
      'period,range,text,last_7_days,',
      'period,start,date,2026-03-09,',
      'period,end,date,2026-03-16,',
    ]);
    expect(rows).toContain('kpi,created,count,2,0');
    expect(rows).toContain('kpi,firstResponseMedian,seconds,2700,');
    expect(rows).toContain('kpi,slaCompliance,percent,,');
    expect(rows).toContain('backlog,open,count,1,');
    expect(rows).toContain('series,2026-03-10,created,1,');
    expect(rows).toContain('channel,email,created,1,');
    expect(rows).toContain('channel,messenger,created,1,');
    expect(rows).toContain('priority,high,created,1,');
    expect(rows).toContain('agent,Ann,resolved,1,');
    expect(rows).toContain('agent,Ann,csat,100,');
    // A name that starts like a formula is neutralised and quoted.
    expect(rows).toContain(`agent,"'=HYPERLINK(""http://evil"")",created,1,`);
  });

  it('reads an unknown range as the last 30 days, like the overview', async () => {
    const res = await app('settings:read').request(`${BASE}/overview/export?range=whenever`);
    expect(res.headers.get('Content-Disposition')).toContain('welddesk-overview-last_30_days-2026-03-15.csv');
    expect((await lines(res))[1]).toBe('period,range,text,last_30_days,');
  });
});

describe('GET /reports/:reportId/export', () => {
  it('needs settings:read', async () => {
    expect((await app('settings:create').request(`${BASE}/reports/rpt_exp/export`)).status).toBe(403);
  });

  it('answers 404 for an unknown or deleted report', async () => {
    expect((await app('settings:read').request(`${BASE}/reports/rpt_nope/export`)).status).toBe(404);
    expect((await app('settings:read').request(`${BASE}/reports/rpt_exp_gone/export`)).status).toBe(404);
  });

  it('writes every chart in the report order as chart,label,value', async () => {
    const res = await app('settings:read').request(`${BASE}/reports/rpt_exp/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="welddesk-report-weekly-volume-q1-2026-03-15.csv"',
    );
    const rows = await lines(res);
    expect(rows[0]).toBe('chart,label,value');
    const body = rows.slice(1);
    // By channel first (sortIndex 0), then the daily series, then the chart without data.
    const first = body.findIndex((line) => line.startsWith('By channel,'));
    const second = body.findIndex((line) => line.startsWith('"Created per day, ""daily""",'));
    const third = body.findIndex((line) => line.startsWith('Unknown metric,'));
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(body).toContain('By channel,email,1');
    expect(body).toContain('By channel,messenger,1');
    expect(body).toContain('"Created per day, ""daily""",2026-03-10,1');
    expect(body[third]).toBe('Unknown metric,,');
    expect(body.some((line) => line.startsWith('Deleted chart'))).toBe(false);
  });

  it('names the file after the report id when the title leaves no letters', async () => {
    const res = await app('settings:read').request(`${BASE}/reports/rpt_exp_empty/export`);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="welddesk-report-rpt_exp_empty-2026-03-15.csv"');
    expect(await lines(res)).toEqual(['chart,label,value']);
  });
});

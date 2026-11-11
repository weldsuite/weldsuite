/**
 * /api/helpdesk-analytics/schedules (TASK-1228) on pglite: list, create with
 * its validation, update (what moves `nextRunAt`), delete, and send now; every
 * mutation's permission, the entity event it publishes and the due index mark.
 *
 * The clock is faked to Sunday 2026-03-15 12:00 UTC.
 *
 * The outbound mail guard runs for real; its ledger (`OUTBOUND_LEDGER`) is a
 * stub that allows or refuses, and the workspace resolves through a master
 * pglite. In conformance mode the Rust server's guard asks the same stub (the
 * ledger bridge), so both runs call it and the assertions on its calls read
 * every call alike. Mail is observed on a `SEND_EMAIL` stub.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { REPORT_HELD_BACK_MESSAGE } from '../../services/desk-report-schedules';
import { readSent } from '../../test/sent-mail';
import { helpdeskAnalyticsRoutes } from './index';

// What the routes publish, kept to assert on. The real publisher still runs, so in
// conformance mode the event reaches the harness, which compares it with Rust's.
const published = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEvent: vi.fn((event: Record<string, unknown>) => {
      const { c: _c, ...rest } = event;
      published.push(JSON.parse(JSON.stringify(rest)) as Record<string, unknown>);
      actual.publishEntityEvent(event as never);
    }),
  };
});

// The guard resolves the workspace through the master database.
const masters = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(masters.db),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => {
      if (orgId !== 'org_test_default') throw new Error(`workspace not found: ${orgId}`);
      return { id: 'ws_test_default', clerkOrgId: 'org_test_default' };
    },
  };
});

type ReserveRequest = { source: string; kind: string; sender: string; recipients: string[] };
type LedgerDecision = {
  allow: boolean;
  mode: 'enforce';
  reservationId: string | null;
  denial?: Record<string, unknown>;
};
const ALLOW: LedgerDecision = { allow: true, mode: 'enforce', reservationId: 'res_1' };

/**
 * The workspace's `OUTBOUND_LEDGER`: `reserve` answers `decision`, which a
 * test sets to a refusal. Both runs call it in conformance mode.
 */
const ledger = {
  decision: ALLOW,
  calls: { reserve: [] as unknown[][], commit: [] as unknown[][], release: [] as unknown[][] },
};
const ledgerStub = {
  reserve: async (...args: unknown[]) => {
    ledger.calls.reserve.push(args);
    return ledger.decision;
  },
  commit: async (...args: unknown[]) => {
    ledger.calls.commit.push(args);
  },
  release: async (...args: unknown[]) => {
    ledger.calls.release.push(args);
  },
};
const ledgerNamespace = { idFromName: (name: string) => name, get: () => ledgerStub };

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const BASE = '/api/helpdesk-analytics/schedules';
const USER = 'user_test_default';
const ORG = 'org_test_default';
const WORKSPACE = 'ws_test_default';
const NOW = new Date('2026-03-15T12:00:00Z');
const { helpdeskReportSchedules: schedules } = schema;

let db: Database;
let master: MasterDatabase;
let mail = createSendEmailStub();
let index = createSqliteD1(MIGRATION);

function app(...keys: string[]) {
  return createTestApp('/api/helpdesk-analytics', helpdeskAnalyticsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master as unknown as Database },
    env: { SEND_EMAIL: mail, SCHEDULE_INDEX: index, OUTBOUND_LEDGER: ledgerNamespace, ENVIRONMENT: 'test' } as never,
  });
}

const READ = () => app('settings:read');
const CREATE = () => app('settings:create');
const UPDATE = () => app('settings:update');
const DELETE = () => app('settings:delete');

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const valid = {
  name: 'Weekly team report',
  frequency: 'weekly',
  dayOfWeek: 1,
  hour: 9,
  timezone: 'Europe/Amsterdam',
  recipients: ['Lead@Example.com', 'lead@example.com', ' ops@example.com '],
};

type Dto = Record<string, unknown> & { id: string };

async function create(body: Record<string, unknown> = valid): Promise<Dto> {
  const res = await CREATE().request(`${BASE}`, send('POST', body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Dto }).data;
}

async function dueAt(): Promise<number | null> {
  const { results } = await (index as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('desk_report', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  masters.db = master;
  await master.insert(masterSchema.workspaces).values({
    id: WORKSPACE,
    name: 'Schedules',
    slug: 'schedules',
    clerkOrgId: ORG,
  } as typeof masterSchema.workspaces.$inferInsert);
  await db.insert(schema.helpdeskAnalyticsReports).values([
    { id: 'rpt_sched_live', title: 'Live report', chartCount: 0 },
    { id: 'rpt_sched_gone', title: 'Gone report', chartCount: 0, deletedAt: new Date('2026-03-01T00:00:00Z') },
  ]);
  await db.insert(schema.workspaceMembers).values({ id: 'wm_sched', userId: USER, name: 'Test Agent', email: 'agent@example.com' });
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  await db.delete(schedules);
  published.splice(0);
  ledger.decision = ALLOW;
  for (const list of Object.values(ledger.calls)) list.length = 0;
  mail = createSendEmailStub();
  index = createSqliteD1(MIGRATION);
});

describe('permissions', () => {
  it('refuses every call without its permission', async () => {
    expect((await app('settings:create').request(BASE)).status).toBe(403);
    expect((await READ().request(BASE, send('POST', valid))).status).toBe(403);
    expect((await READ().request(`${BASE}/rsch_x`, send('PATCH', { name: 'x' }))).status).toBe(403);
    expect((await READ().request(`${BASE}/rsch_x`, send('DELETE'))).status).toBe(403);
    expect((await READ().request(`${BASE}/rsch_x/send`, send('POST'))).status).toBe(403);
    // Send now is an update, not a create.
    expect((await CREATE().request(`${BASE}/rsch_x/send`, send('POST'))).status).toBe(403);
  });
});

describe('POST /schedules', () => {
  it('creates a schedule with the next run, the creator and clean recipients', async () => {
    const dto = await create();
    expect(dto).toMatchObject({
      name: 'Weekly team report',
      reportId: null,
      reportTitle: null,
      range: 'last_7_days',
      frequency: 'weekly',
      dayOfWeek: 1,
      dayOfMonth: null,
      hour: 9,
      timezone: 'Europe/Amsterdam',
      // Lower-cased, trimmed, deduplicated, in the order given.
      recipients: ['lead@example.com', 'ops@example.com'],
      attachCsv: true,
      locale: 'en',
      enabled: true,
      createdById: USER,
      // Monday 16 March 09:00 CET.
      nextRunAt: '2026-03-16T08:00:00.000Z',
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
    });
    expect(typeof dto.createdAt).toBe('string');
    expect(typeof dto.updatedAt).toBe('string');
    expect(typeof dto.id).toBe('string');
  });

  it('marks the workspace due at the next run and publishes a created event', async () => {
    const dto = await create();
    expect(await dueAt()).toBe(Date.parse('2026-03-16T08:00:00Z'));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      entityType: 'helpdesk_report_schedule',
      action: 'created',
      // In conformance mode the event kept here is the TypeScript run's, about the row that
      // run created (the answer is Rust's, with Rust's new id); the harness compares the two.
      entityId: conformanceTarget() ? expect.any(String) : dto.id,
      data: { name: 'Weekly team report', nextRunAt: '2026-03-16T08:00:00.000Z' },
    });
    expect(published[0]!.entityId).toBe((published[0]!.data as { id: string }).id);
  });

  it('keeps a saved report and its title, a range, a locale and a CSV switch', async () => {
    const dto = await create({
      name: 'Monthly',
      frequency: 'monthly',
      dayOfMonth: 28,
      dayOfWeek: 3,
      hour: 7,
      timezone: 'UTC',
      recipients: ['a@example.com'],
      reportId: 'rpt_sched_live',
      range: 'last_30_days',
      attachCsv: false,
      locale: 'nl',
    });
    expect(dto).toMatchObject({
      reportId: 'rpt_sched_live',
      reportTitle: 'Live report',
      range: 'last_30_days',
      attachCsv: false,
      locale: 'nl',
      // A day field its frequency does not use is dropped.
      dayOfWeek: null,
      dayOfMonth: 28,
      nextRunAt: '2026-03-28T07:00:00.000Z',
    });
  });

  it('creates a disabled schedule without a next run and marks nothing due', async () => {
    const dto = await create({ ...valid, enabled: false });
    expect(dto.enabled).toBe(false);
    expect(dto.nextRunAt).toBeNull();
    expect(await dueAt()).toBeNull();
  });

  it('answers a daily schedule without day fields', async () => {
    const dto = await create({ name: 'Daily', frequency: 'daily', hour: 6, timezone: 'UTC', recipients: ['a@example.com'] });
    expect(dto).toMatchObject({ dayOfWeek: null, dayOfMonth: null, nextRunAt: '2026-03-16T06:00:00.000Z' });
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a name over 255 characters', { name: 'x'.repeat(256) }],
    ['an unknown frequency', { frequency: 'hourly' }],
    ['a weekly schedule without dayOfWeek', { dayOfWeek: undefined }],
    ['a monthly schedule without dayOfMonth', { frequency: 'monthly', dayOfMonth: undefined, dayOfWeek: undefined }],
    ['a day of week of 7', { dayOfWeek: 7 }],
    ['a day of month of 29', { frequency: 'monthly', dayOfMonth: 29 }],
    ['an hour of 24', { hour: 24 }],
    ['a time zone that does not exist', { timezone: 'Mars/Olympus' }],
    ['no recipients', { recipients: [] }],
    ['a recipient that is not an email', { recipients: ['not-an-email'] }],
    ['21 recipients', { recipients: Array.from({ length: 21 }, (_, i) => `r${i}@example.com`) }],
    ['an unknown range', { range: 'forever' }],
    ['an unknown locale', { locale: 'fr' }],
    ['a saved report that does not exist', { reportId: 'rpt_nope' }],
    ['a saved report that was deleted', { reportId: 'rpt_sched_gone' }],
  ])('refuses %s with a 400', async (_label, patch) => {
    const res = await CREATE().request(BASE, send('POST', { ...valid, ...patch }));
    expect(res.status).toBe(400);
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it('accepts exactly 20 recipients', async () => {
    const dto = await create({ ...valid, recipients: Array.from({ length: 20 }, (_, i) => `r${i}@example.com`) });
    expect(dto.recipients as string[]).toHaveLength(20);
  });
});

describe('GET /schedules', () => {
  it('lists the newest first with the report title', async () => {
    const first = await create({ ...valid, name: 'First' });
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const second = await create({ ...valid, name: 'Second', reportId: 'rpt_sched_live' });
    vi.setSystemTime(NOW);

    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Dto[] };
    expect(data.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(data[0]).toMatchObject({ reportTitle: 'Live report' });
    expect(data[1]).toMatchObject({ reportTitle: null });
  });

  it('answers an empty list on an empty workspace', async () => {
    const res = await READ().request(BASE);
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe('PATCH /schedules/:id', () => {
  it('404s an unknown schedule', async () => {
    expect((await UPDATE().request(`${BASE}/rsch_nope`, send('PATCH', { name: 'x' }))).status).toBe(404);
  });

  it('changes the name and recipients without moving the next run', async () => {
    const dto = await create();
    vi.setSystemTime(new Date('2026-03-15T13:00:00Z'));
    const res = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { name: 'Renamed', recipients: ['New@Example.com'] }));
    vi.setSystemTime(NOW);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Dto };
    expect(data).toMatchObject({ name: 'Renamed', recipients: ['new@example.com'], nextRunAt: dto.nextRunAt });
    expect(published.at(-1)).toMatchObject({ action: 'updated', entityId: dto.id });
  });

  it('moves the next run when the timing changes and marks the workspace due', async () => {
    const dto = await create();
    const res = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { frequency: 'daily', hour: 18, timezone: 'UTC' }));
    const { data } = (await res.json()) as { data: Dto };
    expect(data).toMatchObject({ frequency: 'daily', dayOfWeek: null, hour: 18, nextRunAt: '2026-03-15T18:00:00.000Z' });
    expect(await dueAt()).toBe(Date.parse('2026-03-15T18:00:00Z'));
  });

  it('merges a partial timing with the stored one and checks the result', async () => {
    const dto = await create();
    // Weekly stays weekly: only the weekday changes (Wednesday 09:00 CET = 08:00 UTC).
    const ok = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { dayOfWeek: 3 }));
    expect(((await ok.json()) as { data: Dto }).data.nextRunAt).toBe('2026-03-18T08:00:00.000Z');
    // Switching to monthly without a day of the month is refused; with one it is fine.
    expect((await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { frequency: 'monthly' }))).status).toBe(400);
    const monthly = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { frequency: 'monthly', dayOfMonth: 1 }));
    expect(((await monthly.json()) as { data: Dto }).data).toMatchObject({ dayOfWeek: null, dayOfMonth: 1, nextRunAt: '2026-04-01T07:00:00.000Z' });
  });

  it('clears the next run when disabled and sets it again when re-enabled', async () => {
    const dto = await create();
    const off = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { enabled: false }));
    expect(((await off.json()) as { data: Dto }).data).toMatchObject({ enabled: false, nextRunAt: null });

    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));
    const on = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { enabled: true }));
    vi.setSystemTime(NOW);
    // Friday 20 March: the next Monday is the 23rd.
    expect(((await on.json()) as { data: Dto }).data).toMatchObject({ enabled: true, nextRunAt: '2026-03-23T08:00:00.000Z' });
  });

  it('points at another saved report, or back at the overview, and refuses one that does not exist', async () => {
    const dto = await create();
    const toReport = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { reportId: 'rpt_sched_live' }));
    expect(((await toReport.json()) as { data: Dto }).data).toMatchObject({ reportId: 'rpt_sched_live', reportTitle: 'Live report' });
    expect((await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { reportId: 'rpt_sched_gone' }))).status).toBe(400);
    const back = await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { reportId: null }));
    expect(((await back.json()) as { data: Dto }).data).toMatchObject({ reportId: null, reportTitle: null });
  });

  it('validates the fields it is given', async () => {
    const dto = await create();
    expect((await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { hour: 99 }))).status).toBe(400);
    expect((await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { recipients: [] }))).status).toBe(400);
    expect((await UPDATE().request(`${BASE}/${dto.id}`, send('PATCH', { timezone: 'Nowhere/Land' }))).status).toBe(400);
  });
});

describe('DELETE /schedules/:id', () => {
  it('deletes the schedule with a 204 and publishes a deleted event', async () => {
    const dto = await create();
    const res = await DELETE().request(`${BASE}/${dto.id}`, send('DELETE'));
    expect(res.status).toBe(204);
    expect(await db.select().from(schedules).where(eq(schedules.id, dto.id))).toHaveLength(0);
    expect(published.at(-1)).toMatchObject({ entityType: 'helpdesk_report_schedule', action: 'deleted', entityId: dto.id });
  });

  it('404s an unknown schedule', async () => {
    expect((await DELETE().request(`${BASE}/rsch_nope`, send('DELETE'))).status).toBe(404);
  });
});

describe('POST /schedules/:id/send', () => {
  it('404s an unknown schedule', async () => {
    expect((await UPDATE().request(`${BASE}/rsch_nope/send`, send('POST'))).status).toBe(404);
  });

  it('sends it now to its recipients, records it and leaves the next run alone', async () => {
    const dto = await create({ ...valid, attachCsv: true });
    vi.setSystemTime(new Date('2026-03-15T13:30:00Z'));
    const res = await UPDATE().request(`${BASE}/${dto.id}/send`, send('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'sent' } });

    // One message per recipient (the binding takes one at a time).
    const sent = readSent(mail);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['lead@example.com', 'ops@example.com']);
    expect(sent[0]!.subject).toBe('WeldDesk report: Overview (Mar 9, 2026 to Mar 15, 2026)');
    expect(sent[0]!.attachments[0]!.filename).toBe('welddesk-overview-last_7_days-2026-03-15.csv');
    expect(sent[0]!.text).toContain('Test Agent scheduled this report ("Weekly team report") in WeldDesk.');

    const [row] = await db.select().from(schedules).where(eq(schedules.id, dto.id));
    expect(row!.lastStatus).toBe('sent');
    expect(row!.lastError).toBeNull();
    expect(row!.lastRunAt?.toISOString()).toBe('2026-03-15T13:30:00.000Z');
    expect(row!.nextRunAt?.toISOString()).toBe(dto.nextRunAt);
    expect(published.at(-1)).toMatchObject({ action: 'updated', entityId: dto.id });
    vi.setSystemTime(NOW);
  });

  it('sends a disabled schedule too, and no CSV when it says so', async () => {
    const dto = await create({ ...valid, enabled: false, attachCsv: false });
    const res = await UPDATE().request(`${BASE}/${dto.id}/send`, send('POST'));
    expect(await res.json()).toEqual({ data: { status: 'sent' } });
    expect(readSent(mail)[0]!.attachments).toEqual([]);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, dto.id));
    expect(row!.nextRunAt).toBeNull();
  });

  it('answers failed with the reason when the mail cannot go out, and records it', async () => {
    const dto = await create();
    const res = await createTestApp('/api/helpdesk-analytics', helpdeskAnalyticsRoutes, {
      context: { permissions: permissions('settings:update'), tenantDb: db, masterDb: master as unknown as Database },
      env: { ENVIRONMENT: 'test' } as never,
    }).request(`${BASE}/${dto.id}/send`, send('POST'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string; error?: string } };
    expect(data.status).toBe('failed');
    expect(data.error).toMatch(/not configured/);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, dto.id));
    expect(row).toMatchObject({ lastStatus: 'failed', lastError: data.error });
  });

  it('commits an allowed send with the guard, as the desk_report source', async () => {
    const dto = await create();
    await UPDATE().request(`${BASE}/${dto.id}/send`, send('POST'));
    // Asked once per run, as WeldSuite's own sender (no sender address to count).
    expect(ledger.calls.reserve.length).toBeGreaterThan(0);
    for (const [subject, request] of ledger.calls.reserve as Array<[unknown, ReserveRequest]>) {
      expect(subject).toMatchObject({ kind: 'workspace', workspaceId: WORKSPACE, clerkOrgId: ORG });
      expect(request).toMatchObject({
        source: 'desk_report',
        kind: 'new_thread',
        sender: '',
        recipients: ['lead@example.com', 'ops@example.com'],
      });
    }
    expect(ledger.calls.commit).toHaveLength(ledger.calls.reserve.length);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('answers failed, 200, and records it when the outbound guard refuses', async () => {
    const dto = await create();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ledger.decision = { allow: false, mode: 'enforce', reservationId: null, denial: { code: 'SENDING_ON_HOLD', reason: 'review' } };
    const res = await UPDATE().request(`${BASE}/${dto.id}/send`, send('POST'));
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'failed', error: REPORT_HELD_BACK_MESSAGE } });
    expect(mail.sent).toHaveLength(0);
    expect(ledger.calls.commit).toHaveLength(0);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, dto.id));
    expect(row).toMatchObject({ lastStatus: 'failed', lastError: REPORT_HELD_BACK_MESSAGE });
    expect(row!.nextRunAt?.toISOString()).toBe(dto.nextRunAt);
  });

  it('answers failed when the saved report was deleted since', async () => {
    const dto = await create({ ...valid, reportId: 'rpt_sched_live' });
    await db.update(schema.helpdeskAnalyticsReports).set({ deletedAt: new Date() }).where(eq(schema.helpdeskAnalyticsReports.id, 'rpt_sched_live'));
    try {
      const res = await UPDATE().request(`${BASE}/${dto.id}/send`, send('POST'));
      expect(await res.json()).toEqual({ data: { status: 'failed', error: 'The saved report no longer exists.' } });
      expect(mail.sent).toHaveLength(0);
    } finally {
      await db.update(schema.helpdeskAnalyticsReports).set({ deletedAt: null }).where(eq(schema.helpdeskAnalyticsReports.id, 'rpt_sched_live'));
    }
  });
});

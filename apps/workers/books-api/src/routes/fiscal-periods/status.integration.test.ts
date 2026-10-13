/**
 * The fiscal calendar reports each stored period's status (open or closed),
 * closing and reopening move it, and a period under an entity lock date is
 * flagged as locked. TASK-1118.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { fiscalPeriodsRoutes } from './index';

let db: Database;
const env = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

interface Result {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db, userId: 'user_closer' },
    env,
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: Result['error'] }) : {};
  return { status: res.status, data: (json.data ?? {}) as Record<string, any>, error: json.error }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const periods = (path: string, opts: Parameters<typeof call>[3] = {}) => call('/api/fiscal-periods', fiscalPeriodsRoutes, `/api/fiscal-periods${path}`, opts);

let entityId: string;

type CalendarPeriod = { name: string; existingId: string | null; existingStatus: string | null; closedAt: string | null; locked: boolean };

async function calendar(): Promise<CalendarPeriod[]> {
  const res = await periods(`/calendar?entityId=${entityId}&fiscalYear=2026`);
  expect(res.status).toBe(200);
  return res.data.periods as CalendarPeriod[];
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: { name: 'Status BV', jurisdictionCode: 'NL', seedDefaults: false },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;
}, 120_000);

describe('fiscal period status in the calendar', () => {
  it('has no status for periods that do not exist yet', async () => {
    const all = await calendar();
    expect(all).toHaveLength(12);
    expect(all.every((p) => p.existingId === null && p.existingStatus === null && p.locked === false)).toBe(true);
  });

  it('shows generated periods as open, closed ones as closed, and reopened ones as open again', async () => {
    expect((await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: 2026 } })).status).toBe(201);
    const january = (await calendar()).find((p) => p.name === '2026-01')!;
    expect(january).toMatchObject({ existingStatus: 'open', closedAt: null });

    const closed = await periods(`/${january.existingId}/close`, { method: 'POST' });
    expect(closed.status).toBe(200);
    expect(closed.data).toMatchObject({ status: 'closed' });
    const afterClose = (await calendar()).find((p) => p.name === '2026-01')!;
    expect(afterClose.existingStatus).toBe('closed');
    expect(afterClose.closedAt).toBeTruthy();
    // The other months are untouched.
    expect((await calendar()).filter((p) => p.existingStatus === 'open')).toHaveLength(11);

    const [row] = await db.select().from(schema.fiscalPeriods).where(eq(schema.fiscalPeriods.id, january.existingId!));
    expect(row?.closedBy).toBe('user_closer');
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, january.existingId!));
    expect(audit.map((a) => a.action)).toContain('closed');

    expect((await periods(`/${january.existingId}/close`, { method: 'POST' })).status).toBe(400);

    const reopened = await periods(`/${january.existingId}/reopen`, { method: 'POST' });
    expect(reopened.status).toBe(200);
    expect((await calendar()).find((p) => p.name === '2026-01')).toMatchObject({ existingStatus: 'open', closedAt: null });
    expect((await periods(`/${january.existingId}/reopen`, { method: 'POST' })).status).toBe(400);
  });

  it('close and reopen need reports:update', async () => {
    const february = (await calendar()).find((p) => p.name === '2026-02')!;
    const denied = await periods(`/${february.existingId}/close`, { method: 'POST', perms: ['reports:read'] });
    expect(denied.status).toBe(403);
    expect((await calendar()).find((p) => p.name === '2026-02')!.existingStatus).toBe('open');
  });

  it('flags the periods an entity lock date covers as locked', async () => {
    await call('/api/accounting-entities', accountingEntitiesRoutes, `/api/accounting-entities/${entityId}/lock-dates`, {
      method: 'PATCH',
      body: { periodLockDate: '2026-02-28' },
    });
    const all = await calendar();
    expect(all.filter((p) => p.locked).map((p) => p.name)).toEqual(['2026-01', '2026-02']);
  });
});

/**
 * Fiscal period generation on pglite: month-based years keep calendar months
 * (NL unchanged, any start month), 52-53-week years get 4-4-5 week periods
 * with the 53rd week in period 12.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { fiscalYearFor } from '@weldsuite/books-domain/us-compliance/fiscal-year';
import { diffDays } from '@weldsuite/books-domain/us-compliance/dates';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { fiscalPeriodsRoutes } from './index';

let db: Database;
const sent: Array<{ eventType: string }> = [];
const env = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32), ENTITY_EVENTS: { send: async (m: { eventType: string }) => void sent.push(m) } };

interface Result {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db }, env });
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

async function createEntity(body: Record<string, unknown>): Promise<string> {
  const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', { method: 'POST', body });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

const US = {
  jurisdictionCode: 'US',
  entityType: 'single_member_llc',
  taxIdentifiers: { einOrSsn: '123456789' },
  address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
};

/** Weeks per period of a generated year, in order. */
const weeksOf = (rows: Array<{ startDate: string; endDate: string }>) => rows.map((row) => (diffDays(row.startDate, row.endDate) + 1) / 7);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

describe('52-53-week fiscal years', () => {
  // The year ends on the last Saturday of December.
  const config = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'last' } as const;
  let entityId: string;

  beforeAll(async () => {
    entityId = await createEntity({ ...US, name: 'Weeks LLC', fiscalYearConfig: config });
  });

  it('a 52-week year is twelve 4-4-5 periods', async () => {
    const year = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032].find((y) => fiscalYearFor(config, y).weeks === 52)!;
    const res = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: year } });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ fiscalYear: year, kind: 'fifty_two_fifty_three', weeks: 52, skipped: [] });
    expect(res.data.created).toHaveLength(12);
    expect(weeksOf(res.data.created)).toEqual([4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5]);
    expect(res.data.created[0]).toMatchObject({ name: `FY${year} P01`, type: 'period', status: 'open', entityId });
    expect(res.data.created[11].name).toBe(`FY${year} P12`);
  });

  it('a 53-week year has the extra week in period 12, and the periods run on without a gap', async () => {
    const year = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034].find((y) => fiscalYearFor(config, y).weeks === 53);
    expect(year).toBeTruthy();
    const expected = fiscalYearFor(config, year!);
    const res = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: year } });
    expect(res.status).toBe(201);
    expect(res.data.weeks).toBe(53);
    expect(weeksOf(res.data.created)).toEqual([4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 6]);
    expect(res.data.created[0].startDate).toBe(expected.start);
    expect(res.data.created[11].endDate).toBe(expected.end);
    const sorted = [...res.data.created].sort((a: { startDate: string }, b: { startDate: string }) => a.startDate.localeCompare(b.startDate));
    for (let i = 1; i < sorted.length; i++) {
      expect(diffDays(sorted[i - 1].endDate, sorted[i].startDate)).toBe(1);
    }
    // The last day of the year is a Saturday.
    expect(new Date(`${expected.end}T00:00:00Z`).getUTCDay()).toBe(6);
  });

  it('generating again creates nothing; quarters and the year can be added', async () => {
    const year = [2024, 2025, 2026, 2027, 2028, 2029].find((y) => fiscalYearFor(config, y).weeks === 52)!;
    const again = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: year } });
    expect(again.data.created).toEqual([]);
    expect(again.data.skipped).toHaveLength(12);

    const more = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: year, includeQuarters: true, includeYear: true } });
    expect(more.data.created.map((p: { type: string }) => p.type)).toEqual(['quarter', 'quarter', 'quarter', 'quarter', 'year']);
    expect(weeksOf(more.data.created.filter((p: { type: string }) => p.type === 'quarter'))).toEqual([13, 13, 13, 13]);
    expect(weeksOf(more.data.created.filter((p: { type: string }) => p.type === 'year'))).toEqual([52]);
    expect(sent.filter((m) => m.eventType === 'fiscal_period:created').length).toBeGreaterThanOrEqual(12 + 12 + 5);
  });

  it('the calendar previews the periods and marks the ones that exist', async () => {
    const year = [2024, 2025, 2026, 2027, 2028, 2029].find((y) => fiscalYearFor(config, y).weeks === 52)!;
    const calendar = await periods(`/calendar?entityId=${entityId}&fiscalYear=${year}`);
    expect(calendar.status).toBe(200);
    expect(calendar.data.periods).toHaveLength(12);
    expect(calendar.data.periods.every((p: { existingId: string | null }) => p.existingId)).toBe(true);
    const unused = await periods(`/calendar?entityId=${entityId}&fiscalYear=${year + 20}`);
    expect(unused.data.periods.every((p: { existingId: string | null }) => p.existingId === null)).toBe(true);
    expect(unused.data.periods.map((p: { weeks: number }) => p.weeks).reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(52);
  });

  it('a closed 4-4-5 period still blocks bookings dated inside it', async () => {
    const year = [2024, 2025, 2026, 2027, 2028, 2029].find((y) => fiscalYearFor(config, y).weeks === 52)!;
    const rows = await db.select().from(schema.fiscalPeriods).where(eq(schema.fiscalPeriods.entityId, entityId));
    const first = rows.find((row) => row.name === `FY${year} P01`)!;
    const closed = await periods(`/${first.id}/close`, { method: 'POST' });
    expect(closed.status).toBe(200);
    const { assertPeriodOpen, ClosedPeriodError } = await import('@weldsuite/books-domain/accounting-guards');
    await expect(assertPeriodOpen(db, entityId, first.startDate)).rejects.toBeInstanceOf(ClosedPeriodError);
    await expect(assertPeriodOpen(db, entityId, first.endDate)).rejects.toBeInstanceOf(ClosedPeriodError);
    const open = rows.find((row) => row.name === `FY${year} P02`)!;
    await expect(assertPeriodOpen(db, entityId, open.startDate)).resolves.toBeUndefined();
  });
});

describe('month-based fiscal years', () => {
  it('a Dutch entity gets twelve calendar months, as before', async () => {
    const entityId = await createEntity({ name: 'Maanden BV', jurisdictionCode: 'NL', vatNumber: 'NL123456789B01', taxIdentifiers: { registrationNumber: '12345678' } });
    const res = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: 2026 } });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ kind: 'month', weeks: null, startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(res.data.created.map((p: { name: string }) => p.name)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`));
    expect(res.data.created.every((p: { type: string }) => p.type === 'month')).toBe(true);
    expect(res.data.created[1]).toMatchObject({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(res.data.created[11]).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  it('an April-March year is named for the year it ends in', async () => {
    const entityId = await createEntity({ ...US, name: 'April LLC', fiscalYearStart: 4 });
    const res = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: 2026 } });
    expect(res.data).toMatchObject({ startDate: '2025-04-01', endDate: '2026-03-31' });
    expect(res.data.created[0]).toMatchObject({ name: '2025-04', startDate: '2025-04-01' });
    expect(res.data.created[11]).toMatchObject({ name: '2026-03', endDate: '2026-03-31' });
    const withQuarters = await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: 2026, includeQuarters: true } });
    expect(withQuarters.data.created.map((p: { name: string }) => p.name)).toEqual(['FY2026 Q1', 'FY2026 Q2', 'FY2026 Q3', 'FY2026 Q4']);
    expect(withQuarters.data.created[0]).toMatchObject({ startDate: '2025-04-01', endDate: '2025-06-30' });
  });

  it('periods can still be created by hand and are gated by the report permissions', async () => {
    const entityId = await createEntity({ name: 'Handwerk BV', jurisdictionCode: 'NL', vatNumber: 'NL123456789B01', taxIdentifiers: { registrationNumber: '12345678' } });
    const made = await periods('', { method: 'POST', body: { name: 'Q1', entityId, startDate: '2026-01-01', endDate: '2026-03-31', type: 'quarter' } });
    expect(made.status).toBe(201);
    expect((await periods('/generate', { perms: ['reports:read'], method: 'POST', body: { entityId, fiscalYear: 2026 } })).status).toBe(403);
    expect((await periods('/calendar?fiscalYear=2026', { perms: [] })).status).toBe(403);
    expect((await periods('/generate', { method: 'POST', body: { entityId, fiscalYear: 1800 } })).status).toBe(400);
  });
});

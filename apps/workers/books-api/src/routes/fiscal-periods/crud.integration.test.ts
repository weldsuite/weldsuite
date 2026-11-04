/**
 * /api/fiscal-periods (pglite), the plain CRUD: create by hand, list with
 * filters and a cursor, read, edit (never the status), close, reopen and
 * delete, and the refusals of closed periods and unknown ids. The entities are
 * seeded directly; the calendar of a seeded entity is checked too.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { fiscalPeriodsRoutes } from './index';

let db: Database;

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string } = {}) {
  const { request } = createTestApp('/api/fiscal-periods', fiscalPeriodsRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(`/api/fiscal-periods${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entity ? { 'X-Accounting-Entity-Id': opts.entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; pagination?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values([
    { id: 'ent_fp', name: 'Periods BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', fiscalYearStart: 7, hardLockDate: '2025-08-31' },
    { id: 'ent_week', name: 'Weeks Inc', jurisdictionCode: 'US', baseCurrency: 'USD', fiscalYearStart: 1, fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'nearest' } },
  ]);
}, 60_000);

describe('fiscal periods by hand', () => {
  const ids: string[] = [];

  it('creates periods, always open', async () => {
    for (const [name, start, end] of [
      ['2026-01', '2026-01-01', '2026-01-31'],
      ['2026-02', '2026-02-01', '2026-02-28'],
      ['2026-03', '2026-03-01', '2026-03-31'],
    ]) {
      const res = await call('', { method: 'POST', body: { name, entityId: 'ent_fp', startDate: start, endDate: end, type: 'month', status: 'closed' } });
      expect(res.status).toBe(201);
      ids.push(res.data.id);
    }
    expect((await call(`/${ids[0]}`)).data).toMatchObject({ name: '2026-01', status: 'open', startDate: '2026-01-01', closedAt: null });
  });

  it('lists newest first, filtered, with a cursor', async () => {
    const all = await call('?entityId=ent_fp');
    expect(all.data.map((p: { id: string }) => p.id)).toEqual([...ids].reverse());
    const page = await call('?entityId=ent_fp&limit=2');
    expect(page.pagination).toMatchObject({ totalCount: 3, hasMore: true, cursor: ids[1] });
    const next = await call(`?entityId=ent_fp&limit=2&cursor=${page.pagination.cursor}`);
    expect(next.data.map((p: { id: string }) => p.id)).toEqual([ids[0]]);
    const search = await call('?search=-02&status=open');
    expect(search.data.map((p: { id: string }) => p.id)).toEqual([ids[1]]);
  });

  it('edits a period but never its status', async () => {
    const res = await call(`/${ids[2]}`, { method: 'PATCH', body: { name: 'March', status: 'closed', closedBy: 'someone' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: ids[2] });
    expect((await call(`/${ids[2]}`)).data).toMatchObject({ name: 'March', status: 'open', closedBy: null });
  });

  it('closes and reopens', async () => {
    const closed = await call(`/${ids[0]}/close`, { method: 'POST' });
    expect(closed.status).toBe(200);
    expect(closed.data).toEqual({ id: ids[0], status: 'closed' });
    expect((await call(`/${ids[0]}`)).data.status).toBe('closed');
    expect((await call(`/${ids[0]}/close`, { method: 'POST' })).status).toBe(400);
    expect((await call(`/${ids[0]}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(400);
    expect((await call(`/${ids[0]}`, { method: 'DELETE' })).status).toBe(400);
    const reopened = await call(`/${ids[0]}/reopen`, { method: 'POST' });
    expect(reopened.data).toEqual({ id: ids[0], status: 'open' });
    expect((await call(`/${ids[0]}/reopen`, { method: 'POST' })).status).toBe(400);
  });

  it('deletes an open period', async () => {
    expect((await call(`/${ids[1]}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/${ids[1]}`)).status).toBe(404);
  });

  it('refuses unknown ids, bad bodies and missing permissions', async () => {
    expect((await call('/fp_missing', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    expect((await call('/fp_missing/close', { method: 'POST' })).status).toBe(404);
    expect((await call('/fp_missing/reopen', { method: 'POST' })).status).toBe(404);
    expect((await call('/fp_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await call('', { method: 'POST', body: { name: '' } })).status).toBe(400);
    expect((await call('', { method: 'POST', body: { name: 'No type', entityId: 'ent_fp', startDate: '2026-04-01', endDate: '2026-04-30' } })).status).toBe(500);
    expect((await call(`/${ids[2]}`, { method: 'DELETE', perms: ['reports:read'] })).status).toBe(403);
    expect((await call(`/${ids[2]}`, { method: 'PATCH', perms: ['reports:read'], body: {} })).status).toBe(403);
    expect((await call(`/${ids[2]}`, { perms: ['invoices:read'] })).status).toBe(403);
  });
});

describe('the calendar of seeded entities', () => {
  it('a July-June year with a hard lock date', async () => {
    const res = await call('/calendar?fiscalYear=2026&includeQuarters=true&includeYear=true', { entity: 'ent_fp' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ fiscalYear: 2026, startDate: '2025-07-01', endDate: '2026-06-30', kind: 'month', weeks: null, entityId: 'ent_fp' });
    expect(res.data.periods[0]).toMatchObject({ name: '2025-07', locked: true, existingId: null });
    expect(res.data.periods.at(-1)).toMatchObject({ name: 'FY2026', type: 'year' });
    const generated = await call('/generate', { method: 'POST', body: { entityId: 'ent_fp', fiscalYear: 2026, includeQuarters: true } });
    expect(generated.status).toBe(201);
    expect(generated.data.created).toHaveLength(14);
    expect(generated.data.skipped).toHaveLength(2);
  });

  it('a 52-53-week year, and the refusals', async () => {
    const res = await call('/calendar?fiscalYear=2026&entityId=ent_week');
    expect(res.data).toMatchObject({ kind: 'fifty_two_fifty_three' });
    expect(res.data.periods[0].name).toBe('FY2026 P01');
    expect((await call('/calendar?fiscalYear=1980&entityId=ent_week')).status).toBe(400);
    expect((await call('/calendar?fiscalYear=2026&entityId=ent_missing')).status).toBe(404);
    expect((await call('/calendar?fiscalYear=2026')).status).toBe(400);
    expect((await call('/generate', { method: 'POST', body: { fiscalYear: 'x' } })).status).toBe(400);
  });
});

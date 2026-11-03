/**
 * /api/fx-rates (pglite): the stored exchange rates. List with filters and a
 * cursor, read, create, update and delete, and the refusals: permissions,
 * validation, unknown ids, a body without a column to update.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { fxRatesRoutes } from './index';

let db: Database;

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}) {
  const { request } = createTestApp('/api/fx-rates', fxRatesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(`/api/fx-rates${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; pagination?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.fxRates).values([
    { id: 'fxr_a', createdAt: new Date('2026-01-01T10:00:00Z'), date: '2026-01-01', fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08000000', source: 'ecb' },
    { id: 'fxr_b', createdAt: new Date('2026-01-02T10:00:00Z'), date: '2026-01-02', fromCurrency: 'EUR', toCurrency: 'GBP', rate: '0.86000000', source: 'ecb' },
    { id: 'fxr_c', createdAt: new Date('2026-01-03T10:00:00Z'), date: '2026-01-03', fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.09000000', source: 'manual' },
  ]);
}, 60_000);

describe('GET /api/fx-rates', () => {
  it('lists newest first, filtered by currency', async () => {
    const all = await call('');
    expect(all.status).toBe(200);
    expect(all.data.map((r: { id: string }) => r.id)).toEqual(['fxr_c', 'fxr_b', 'fxr_a']);
    expect(all.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const usd = await call('?toCurrency=USD&fromCurrency=EUR');
    expect(usd.data.map((r: { id: string }) => r.id)).toEqual(['fxr_c', 'fxr_a']);
    expect(usd.data[0].rate).toBe('1.09000000');
  });

  it('pages with a cursor', async () => {
    const first = await call('?limit=2');
    expect(first.data.map((r: { id: string }) => r.id)).toEqual(['fxr_c', 'fxr_b']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'fxr_b' });
    const second = await call(`?limit=2&cursor=${first.pagination.cursor}`);
    expect(second.data.map((r: { id: string }) => r.id)).toEqual(['fxr_a']);
    expect(second.pagination.hasMore).toBe(false);
  });

  it('counts without the last filter when the cursor row is gone', async () => {
    const res = await call('?toCurrency=GBP&cursor=fxr_missing');
    expect(res.status).toBe(200);
    expect(res.data.map((r: { id: string }) => r.id)).toEqual(['fxr_b']);
    expect(res.pagination.totalCount).toBe(3);
  });

  it('needs reports:read', async () => {
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
  });
});

describe('GET /api/fx-rates/:id', () => {
  it('reads one rate and 404s an unknown id', async () => {
    const found = await call('/fxr_b');
    expect(found.status).toBe(200);
    expect(found.data).toMatchObject({ id: 'fxr_b', toCurrency: 'GBP', rate: '0.86000000', date: '2026-01-02' });
    const missing = await call('/fxr_missing');
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/fx-rates', () => {
  it('stores a rate and answers its id', async () => {
    const res = await call('', { method: 'POST', body: { fromCurrency: 'EUR', toCurrency: 'CHF', rate: 0.96, date: '2026-02-01' } });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^fx_/);
    const [row] = await db.select().from(schema.fxRates).where(eq(schema.fxRates.id, res.data.id));
    expect(row).toMatchObject({ toCurrency: 'CHF', rate: '0.96000000', source: 'ecb', date: '2026-02-01' });
  });

  it('refuses a body without the currencies or the rate', async () => {
    const res = await call('', { method: 'POST', body: { fromCurrency: '', rate: true } });
    expect(res.status).toBe(400);
  });

  it('fails without a date (the column is required)', async () => {
    const res = await call('', { method: 'POST', body: { fromCurrency: 'EUR', toCurrency: 'SEK', rate: '11.2' } });
    expect(res.status).toBe(500);
  });

  it('needs reports:create', async () => {
    const res = await call('', { method: 'POST', perms: ['reports:read'], body: { fromCurrency: 'EUR', toCurrency: 'NOK', rate: '11.5', date: '2026-02-01' } });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/fx-rates/:id', () => {
  it('changes the rate', async () => {
    const res = await call('/fxr_a', { method: 'PATCH', body: { rate: '1.07500000' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 'fxr_a' });
    expect((await call('/fxr_a')).data.rate).toBe('1.07500000');
  });

  it('404s an unknown id, 400s a bad body, 500s a body without a column', async () => {
    expect((await call('/fxr_missing', { method: 'PATCH', body: { rate: '1' } })).status).toBe(404);
    expect((await call('/fxr_a', { method: 'PATCH', body: { source: 'x'.repeat(51) } })).status).toBe(400);
    expect((await call('/fxr_a', { method: 'PATCH', body: { note: 'not a column' } })).status).toBe(500);
  });

  it('needs reports:update', async () => {
    expect((await call('/fxr_a', { method: 'PATCH', perms: ['reports:read'], body: { rate: '1' } })).status).toBe(403);
  });
});

describe('DELETE /api/fx-rates/:id', () => {
  it('deletes a rate, then 404s it', async () => {
    expect((await call('/fxr_b', { method: 'DELETE', perms: ['reports:read'] })).status).toBe(403);
    expect((await call('/fxr_b', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/fxr_b', { method: 'DELETE' })).status).toBe(404);
  });
});

/**
 * /api/tax-rates (pglite): list (with the lazy update of a Dutch entity's
 * seeded rates), read, update through PATCH and PUT, delete, and the
 * refusals: no entity, unknown ids, a rate on a booking, permissions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { taxRatesRoutes } from './index';

let db: Database;

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string | null } = {}) {
  const { request } = createTestApp('/api/tax-rates', taxRatesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? 'ent_nl' : opts.entity;
  const res = await request(`/api/tax-rates${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values([
    { id: 'ent_nl', name: 'Old BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    { id: 'ent_us', name: 'Rates Inc', jurisdictionCode: 'US', baseCurrency: 'USD' },
  ]);
  // Seeded before the current template: the old EU name, box 1c, a 0% reverse charge, no ICL goods.
  await db.insert(schema.taxRates).values([
    { id: 'txr_high', entityId: 'ent_nl', jurisdictionCode: 'NL', name: 'BTW Hoog 21%', rate: '21.0000', type: 'both', taxCategoryCode: 'standard', jurisdictionMetadata: { btwRubriek: '1a' } },
    { id: 'txr_low', entityId: 'ent_nl', jurisdictionCode: 'NL', name: 'BTW Laag 9%', rate: '9.0000', type: 'both', taxCategoryCode: 'reduced', jurisdictionMetadata: { btwRubriek: '1c' } },
    { id: 'txr_eu', entityId: 'ent_nl', jurisdictionCode: 'NL', name: 'BTW Intracommunautair', rate: '0.0000', type: 'sales', taxCategoryCode: 'eu_b2b_service' },
    { id: 'txr_rc', entityId: 'ent_nl', jurisdictionCode: 'NL', name: 'BTW Verlegd', rate: '0.0000', type: 'purchase', taxCategoryCode: 'reverse_charge', isActive: false },
    { id: 'txr_us', entityId: 'ent_us', jurisdictionCode: 'US', name: 'Exempt', rate: '0.0000', type: 'sales' },
  ]);
}, 60_000);

describe('tax rates', () => {
  it('lists a Dutch entity brought up to the current template', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    const names = res.data.map((r: { name: string }) => r.name);
    expect(names).toContain('BTW Intracommunautair diensten');
    expect(names).toContain('BTW ICL goederen');
    const low = res.data.find((r: { id: string }) => r.id === 'txr_low');
    expect(low.jurisdictionMetadata.btwRubriek).toBe('1b');
    expect(res.data.find((r: { id: string }) => r.id === 'txr_rc').rate).toBe('21.0000');
    const again = await call('');
    expect(again.data).toHaveLength(res.data.length);
  });

  it('filters by type and active', async () => {
    const sales = await call('?type=sales');
    expect(sales.data.every((r: { type: string }) => r.type === 'sales')).toBe(true);
    const inactive = await call('?isActive=false');
    expect(inactive.data.map((r: { id: string }) => r.id)).toEqual(['txr_rc']);
    const us = await call('', { entity: 'ent_us' });
    expect(us.data.map((r: { id: string }) => r.id)).toEqual(['txr_us']);
  });

  it('reads, updates with PATCH and PUT', async () => {
    expect((await call('/txr_us')).data).toMatchObject({ id: 'txr_us', name: 'Exempt', rate: '0.0000' });
    const patched = await call('/txr_us', { method: 'PATCH', body: { name: 'Exempt sales', rate: 0, jurisdictionCode: 'us', isDefault: true } });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ name: 'Exempt sales', rate: '0', jurisdictionCode: 'us', isDefault: true });
    const [row] = await db.select().from(schema.taxRates).where(eq(schema.taxRates.id, 'txr_us'));
    expect(row?.jurisdictionCode).toBe('US');
    const put = await call('/txr_us', { method: 'PUT', body: { taxCategoryCode: 'exempt', jurisdictionMetadata: { note: 'x' } } });
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ taxCategoryCode: 'exempt' });
  });

  it('refuses to delete a rate on a booking, then deletes an unused one', async () => {
    await db.insert(schema.journalEntries).values({ id: 'je_tx', entityId: 'ent_nl', date: new Date('2026-01-01'), status: 'draft' });
    await db.insert(schema.journalLines).values({ id: 'jl_tx', entityId: 'ent_nl', journalEntryId: 'je_tx', accountId: 'acc_x', taxRateId: 'txr_high' });
    const used = await call('/txr_high', { method: 'DELETE' });
    expect(used.status).toBe(400);
    expect(used.error?.message).toBe('Tax rate is used by bookings — deactivate it instead');
    expect((await call('/txr_eu', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/txr_eu')).status).toBe(404);
  });

  it('refuses no entity, unknown ids, bad bodies and missing permissions', async () => {
    expect((await call('', { entity: null })).status).toBe(400);
    expect((await call('/txr_missing', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    expect((await call('/txr_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await call('/txr_us', { method: 'PATCH', body: { type: 'other' } })).status).toBe(400);
    expect((await call('', { method: 'POST', body: { entityId: 'ent_nl', name: 'No code', rate: 5 } })).status).toBe(400);
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call('/txr_us', { method: 'PUT', perms: ['settings:read'], body: {} })).status).toBe(403);
    expect((await call('/txr_us', { method: 'DELETE', perms: ['settings:read'] })).status).toBe(403);
  });
});

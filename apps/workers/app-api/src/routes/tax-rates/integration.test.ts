/**
 * DB-backed integration tests for /api/tax-rates.
 *
 * Tax rates are scoped to an accounting entity (FK on `entityId`) and
 * the DB column is `jurisdictionCode` while the shared Zod schema uses
 * `jurisdiction`. The route bridges both gaps.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { taxRatesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/tax-rates · pglite integration', () => {
  it('POST / writes a tax-rate row', async () => {
    const { request } = createTestApp('/api/tax-rates', taxRatesRoutes, {
      context: { permissions: permissions('settings:create'), tenantDb: db },
    });

    const res = await request('/api/tax-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'VAT 21%',
        code: 'NL-21',
        entityId: 'ent_test',
        jurisdiction: 'NL',
        rate: 21,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    // txr is the prefix the jurisdiction seeding uses — the route matches it.
    expect(body.data.id).toMatch(/^txr_/);

    const [row] = await db
      .select()
      .from(schema.taxRates)
      .where(eq(schema.taxRates.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('VAT 21%');
    expect(row?.jurisdictionCode).toBe('NL');
  });

  it('POST / returns 400 when entityId is missing', async () => {
    const { request } = createTestApp('/api/tax-rates', taxRatesRoutes, {
      context: { permissions: permissions('settings:create'), tenantDb: db },
    });
    const res = await request('/api/tax-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No entity', rate: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/tax-rates', taxRatesRoutes, {
      context: { permissions: permissions('settings:create'), tenantDb: db },
    });
    const res = await request('/api/tax-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', entityId: 'ent_test', rate: 10 }),
    });
    expect(res.status).toBe(400);
  });
});

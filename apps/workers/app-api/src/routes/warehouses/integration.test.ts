/**
 * DB-backed integration tests for /api/warehouses.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { warehousesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/warehouses · pglite integration', () => {
  it('POST / writes a warehouse row', async () => {
    const { request } = createTestApp('/api/warehouses', warehousesRoutes, {
      context: { permissions: permissions('warehouses:create'), tenantDb: db },
    });

    const res = await request('/api/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Main Warehouse', code: 'WH-1' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^wh_/);

    const [row] = await db
      .select()
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Main Warehouse');
    expect(row?.code).toBe('WH-1');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/warehouses', warehousesRoutes, {
      context: { permissions: permissions('warehouses:create'), tenantDb: db },
    });
    const res = await request('/api/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for missing warehouse', async () => {
    const { request } = createTestApp('/api/warehouses', warehousesRoutes, {
      context: { permissions: permissions('warehouses:read'), tenantDb: db },
    });
    const res = await request('/api/warehouses/wh_missing');
    expect(res.status).toBe(404);
  });
});

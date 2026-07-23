/**
 * DB-backed integration tests for /api/accounting-entities.
 *
 * Bridges the DB's `jurisdictionCode` column to the Zod schema's
 * `jurisdiction` field.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingEntitiesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/accounting-entities · pglite integration', () => {
  it('POST / writes an entity and maps jurisdiction → jurisdictionCode', async () => {
    const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
      context: { permissions: permissions('entities:create'), tenantDb: db },
    });

    const res = await request('/api/accounting-entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'WeldHost BV',
        legalName: 'WeldHost B.V.',
        jurisdiction: 'NL',
        baseCurrency: 'EUR',
        vatNumber: 'NL123456789B01',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^ent_/);

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('WeldHost BV');
    expect(row?.jurisdictionCode).toBe('NL');
    expect(row?.baseCurrency).toBe('EUR');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
      context: { permissions: permissions('entities:create'), tenantDb: db },
    });
    const res = await request('/api/accounting-entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

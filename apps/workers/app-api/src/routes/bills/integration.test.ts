/**
 * DB-backed integration tests for /api/bills.
 *
 * The route now enforces entityId/contactId/issueDate/dueDate at the
 * 400 layer, even though the shared Zod schema marks them optional
 * (it's reused for partial updates). These tests pin that contract.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { billsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/bills · pglite integration', () => {
  it('POST / writes a bill when all required fields are present', async () => {
    const { request } = createTestApp('/api/bills', billsRoutes, {
      context: { permissions: permissions('bills:create'), tenantDb: db },
    });

    const res = await request('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entityId: 'ent_e2e',
        contactId: 'ctt_e2e',
        issueDate: '2025-01-15T00:00:00Z',
        dueDate: '2025-02-15T00:00:00Z',
        contactName: 'Office Supplies Co',
        billNumber: 'B-E2E-001',
        currency: 'EUR',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^bil_/);

    const [row] = await db
      .select()
      .from(schema.bills)
      .where(eq(schema.bills.id, body.data.id))
      .limit(1);
    expect(row?.contactName).toBe('Office Supplies Co');
    expect(row?.billNumber).toBe('B-E2E-001');
  });

  it('POST / returns 400 with a useful message when a required field is missing', async () => {
    const { request } = createTestApp('/api/bills', billsRoutes, {
      context: { permissions: permissions('bills:create'), tenantDb: db },
    });
    const res = await request('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId: 'ent_e2e' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/contactId/);
    expect(body.error.message).toMatch(/issueDate/);
    expect(body.error.message).toMatch(/dueDate/);
  });

  it('GET /:id returns 404 for missing bill', async () => {
    const { request } = createTestApp('/api/bills', billsRoutes, {
      context: { permissions: permissions('bills:read'), tenantDb: db },
    });
    const res = await request('/api/bills/bil_missing');
    expect(res.status).toBe(404);
  });
});

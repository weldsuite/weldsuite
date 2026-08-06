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

  it('POST / creates an India entity, seeds GST CoA + rates, and stores stateCode from GSTIN', async () => {
    const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
      context: { permissions: permissions('entities:create'), tenantDb: db },
    });

    const res = await request('/api/accounting-entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Weld India Pvt Ltd',
        jurisdictionCode: 'IN',
        baseCurrency: 'INR',
        vatNumber: '27AABCU9603R1ZM',
        seedDefaults: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; accountsCreated?: number; taxRatesCreated?: number } };
    expect(body.data.id).toMatch(/^ent_/);

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, body.data.id))
      .limit(1);
    expect(row?.jurisdictionCode).toBe('IN');
    expect(row?.baseCurrency).toBe('INR');
    expect(row?.timezone).toBe('Asia/Kolkata');
    expect(row?.taxIdentifiers?.vatNumber).toBe('27AABCU9603R1ZM');
    expect((row?.jurisdictionSettings as { stateCode?: string } | null)?.stateCode).toBe('27');

    const accounts = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.entityId, body.data.id));
    expect(accounts.length).toBeGreaterThan(10);
    const roles = accounts.map((a) => (a.metadata as { systemRole?: string } | null)?.systemRole);
    expect(roles).toContain('tax_output_cgst');
    expect(roles).toContain('tax_output_igst');

    const rates = await db
      .select()
      .from(schema.taxRates)
      .where(eq(schema.taxRates.entityId, body.data.id));
    expect(rates.some((r) => r.name === 'GST 18%' && r.isDefault)).toBe(true);
    expect(rates.some((r) => (r.jurisdictionMetadata as { gstSlab?: string } | null)?.gstSlab === '18')).toBe(true);
  });

  it('POST / rejects invalid GSTIN for India', async () => {
    const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
      context: { permissions: permissions('entities:create'), tenantDb: db },
    });
    const res = await request('/api/accounting-entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad GSTIN Co',
        jurisdictionCode: 'IN',
        baseCurrency: 'INR',
        vatNumber: 'NOT-A-GSTIN',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /jurisdictions includes IN and NL', async () => {
    const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
      context: { permissions: permissions('entities:read'), tenantDb: db },
    });
    const res = await request('/api/accounting-entities/jurisdictions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ code: string }> };
    const codes = body.data.map((j) => j.code).sort();
    expect(codes).toEqual(['IN', 'NL']);
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

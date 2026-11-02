/**
 * The /api/person-companies routes the main integration test leaves out:
 * PATCH, the refusals (validation, not found, permission) and the primary
 * flag moving between links. Runs against the Rust backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { personCompaniesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1));
  await db.insert(schema.personCompanies).values([
    { id: 'pc_one', personId: 'per_1', companyId: 'cmp_1', isPrimary: true, createdAt: at, updatedAt: at },
    { id: 'pc_two', personId: 'per_1', companyId: 'cmp_2', isPrimary: false, createdAt: at, updatedAt: at },
  ]);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/person-companies', personCompaniesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ['contacts:update'])), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/person-companies · PATCH and refusals', () => {
  it('updates a link and moves the primary flag to it', async () => {
    const res = await app().request(
      '/api/person-companies/pc_two',
      json('PATCH', { role: 'billing', isPrimary: true, startedAt: '2025-01-01T00:00:00Z', endedAt: '2025-12-31T00:00:00.000Z' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isPrimary: boolean; role: string } };
    expect(body.data).toMatchObject({ isPrimary: true, role: 'billing' });
    expect((await app().request('/api/person-companies/pc_one', json('PATCH', { isPrimary: false }))).status).toBe(200);
  });

  it('refuses a bad body, a missing link and a missing permission', async () => {
    expect((await app().request('/api/person-companies/pc_two', json('PATCH', { startedAt: '2025-01-01' }))).status).toBe(400);
    expect((await app().request('/api/person-companies/pc_two', json('PATCH', { role: 'x'.repeat(51) }))).status).toBe(400);
    expect((await app().request('/api/person-companies/pc_missing', json('PATCH', { role: 'x' }))).status).toBe(404);
    expect((await app().request('/api/person-companies/pc_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/person-companies', json('POST', { personId: '', companyId: 'cmp_1' }))).status).toBe(400);
    expect((await app('contacts:read').request('/api/person-companies/pc_two', json('PATCH', { role: 'x' }))).status).toBe(403);
    expect((await app('contacts:read').request('/api/person-companies', json('POST', { personId: 'p', companyId: 'c' }))).status).toBe(403);
  });
});

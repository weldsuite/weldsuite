/**
 * Every /api/customer-statuses route on pglite, refusals included
 * (reserved and taken slugs, validation, not found, permissions). The
 * conformance suite runs these against the Rust backend too.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { customerStatusesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1));
  await db.insert(schema.crmCustomerStatuses).values([
    { id: 'ccst_vip', name: 'VIP', slug: 'vip', color: 'gold', sortOrder: 1, createdAt: at, updatedAt: at },
    { id: 'ccst_lapsed', name: 'Lapsed', slug: 'lapsed', color: 'gray', sortOrder: 0, createdAt: at, updatedAt: at },
    { id: 'ccst_old', name: 'Old', slug: 'old', color: 'red', sortOrder: 2, deletedAt: at, createdAt: at, updatedAt: at },
  ]);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/customer-statuses', customerStatusesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ['customers:read', 'settings:manage'])), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/customer-statuses · every route', () => {
  it('lists in order and reads one', async () => {
    const res = await app().request('/api/customer-statuses');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { slug: string }[] }).data.map((s) => s.slug)).toEqual(['lapsed', 'vip']);
    expect((await app().request('/api/customer-statuses/ccst_vip')).status).toBe(200);
    expect((await app().request('/api/customer-statuses/ccst_old')).status).toBe(404);
  });

  it('creates a status and refuses reserved, taken and malformed slugs', async () => {
    const created = await app().request('/api/customer-statuses', json('POST', { name: 'Partner', slug: 'partner', color: 'blue' }));
    expect(created.status).toBe(201);
    expect((await app().request('/api/customer-statuses', json('POST', { name: 'A', slug: 'active', color: 'x' }))).status).toBe(409);
    expect((await app().request('/api/customer-statuses', json('POST', { name: 'V', slug: 'vip', color: 'x' }))).status).toBe(409);
    expect((await app().request('/api/customer-statuses', json('POST', { name: '', slug: 'Bad Slug', color: '' }))).status).toBe(400);
    expect((await app().request('/api/customer-statuses', json('POST', { name: 'S', slug: 'srt', color: 'c', sortOrder: 1.5 }))).status).toBe(400);
  });

  it('updates a status, keeping slugs unique', async () => {
    const res = await app().request('/api/customer-statuses/ccst_vip', json('PATCH', { name: 'Very important', color: 'amber', sortOrder: 5 }));
    expect(res.status).toBe(200);
    expect((await app().request('/api/customer-statuses/ccst_vip', json('PATCH', { slug: 'churned' }))).status).toBe(409);
    expect((await app().request('/api/customer-statuses/ccst_vip', json('PATCH', { slug: 'lapsed' }))).status).toBe(409);
    expect((await app().request('/api/customer-statuses/ccst_vip', json('PATCH', { slug: 'vip' }))).status).toBe(200);
    expect((await app().request('/api/customer-statuses/ccst_missing', json('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app().request('/api/customer-statuses/ccst_vip', json('PATCH', { slug: 'x-y' }))).status).toBe(400);
  });

  it('reorders and deletes', async () => {
    const res = await app().request('/api/customer-statuses/reorder', json('PUT', { ids: ['ccst_vip', 'ccst_lapsed'] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { slug: string }[] }).data.map((s) => s.slug)).toContain('vip');
    expect((await app().request('/api/customer-statuses/reorder', json('PUT', { ids: [] }))).status).toBe(200);
    expect((await app().request('/api/customer-statuses/reorder', json('PUT', { ids: 'x' }))).status).toBe(400);
    expect((await app().request('/api/customer-statuses/ccst_lapsed', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/customer-statuses/ccst_lapsed', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses without the permission', async () => {
    const readOnly = app('customers:read');
    expect((await readOnly.request('/api/customer-statuses', json('POST', { name: 'N', slug: 'n', color: 'c' }))).status).toBe(403);
    expect((await readOnly.request('/api/customer-statuses/ccst_vip', json('PATCH', { name: 'N' }))).status).toBe(403);
    expect((await readOnly.request('/api/customer-statuses/ccst_vip', { method: 'DELETE' })).status).toBe(403);
    expect((await readOnly.request('/api/customer-statuses/reorder', json('PUT', { ids: [] }))).status).toBe(403);
    expect((await app('settings:manage').request('/api/customer-statuses')).status).toBe(403);
  });
});

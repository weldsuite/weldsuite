/**
 * The /api/opportunities routes and refusals the main integration test
 * leaves out: DELETE, the owner scope, the list filters and paging, the
 * schema's refinements and an unknown stage. Runs against the Rust backend
 * in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { opportunitiesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.companies).values([
    { id: 'cmp_live', name: 'Live Co', displayName: 'Live Co', createdAt: at(0), updatedAt: at(0) },
    { id: 'cmp_dead', name: 'Dead Co', displayName: 'Dead Co', deletedAt: at(0), createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.crmOpportunities).values([
    { id: 'opp_a', name: 'Alpha', customerId: 'cmp_live', amount: '1200.50', expectedRevenue: '99.90', ownerId: 'user_test_default', personIds: ['per_1'], createdAt: at(1), updatedAt: at(1) },
    { id: 'opp_b', name: 'Beta', customerId: 'cmp_dead', ownerId: 'user_other', stage: 'proposal', createdAt: at(2), updatedAt: at(2) },
    { id: 'opp_c', name: 'Gamma', customerId: 'cmp_gone', description: 'big deal', ownerId: 'user_test_default', contactIds: ['per_2'], createdAt: at(3), updatedAt: at(3) },
  ]);
}, 60_000);

const ALL = ['opportunities:read', 'opportunities:create', 'opportunities:update', 'opportunities:delete', 'opportunities:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/opportunities', opportunitiesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/opportunities · every route', () => {
  it('lists with filters, paging and the deleted-company flag', async () => {
    const res = await app().request('/api/opportunities?limit=2');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: { id: string; companyDeleted: boolean }[]; pagination: { cursor: string } };
    expect(page.data.map((d) => [d.id, d.companyDeleted])).toEqual([['opp_c', true], ['opp_b', true]]);
    expect((await app().request(`/api/opportunities?limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/opportunities?customerIds=cmp_live, cmp_dead,')).status).toBe(200);
    expect((await app().request('/api/opportunities?personId=per_2')).status).toBe(200);
    expect((await app().request('/api/opportunities?search=big&status=open&stage=prospecting&pipeline=default&ownerId=user_test_default')).status).toBe(200);
    expect((await app('opportunities:read').request('/api/opportunities')).status).toBe(200);
    expect((await app('opportunities:read').request('/api/opportunities/opp_b')).status).toBe(404);
    expect((await app().request('/api/opportunities/opp_a')).status).toBe(200);
  });

  it('refuses the refinements, a bad type and an unknown stage', async () => {
    expect((await app().request('/api/opportunities', json('POST', { name: 'N', customerId: 'cmp_live', amount: -5 }))).status).toBe(400);
    expect((await app().request('/api/opportunities', json('POST', { name: 'N', customerId: 'cmp_live', amount: 'abc', currency: 'EURO' }))).status).toBe(400);
    expect((await app().request('/api/opportunities', json('POST', { name: 'N', customerId: 'cmp_live', currency: 'XYZ', closeDate: 'soon' }))).status).toBe(400);
    expect((await app().request('/api/opportunities', json('POST', { name: '', amount: true, probability: 101 }))).status).toBe(400);
    expect((await app().request('/api/opportunities/opp_a', json('PATCH', { stageId: 'pls_missing' }))).status).toBe(400);
    expect((await app().request('/api/opportunities/opp_missing', json('PATCH', { name: 'x' }))).status).toBe(404);
  });

  it('creates with numbers as strings and updates the company name', async () => {
    const res = await app().request('/api/opportunities', json('POST', { name: 'Delta', customerId: 'cmp_live', amount: 300, expectedRevenue: '10', currency: '', closeDate: '2026-06-30', startDate: '2026-01-15', teamMembers: ['u1'] }));
    expect(res.status).toBe(201);
    expect((await app().request('/api/opportunities/opp_c', json('PATCH', { customerId: 'cmp_live', amount: 50, currency: '', closeDate: '' }))).status).toBe(200);
    expect((await app().request('/api/opportunities/opp_c', json('PATCH', { customerId: 'cmp_unknown', nextStepDate: '2026-02-02' }))).status).toBe(200);
    expect((await app().request('/api/opportunities/opp_c')).status).toBe(200);
  });

  it('deletes and refuses without the permission', async () => {
    expect((await app('opportunities:read').request('/api/opportunities', json('POST', { name: 'N', customerId: 'c' }))).status).toBe(403);
    expect((await app('opportunities:read').request('/api/opportunities/opp_a', json('PATCH', {}))).status).toBe(403);
    expect((await app('opportunities:read').request('/api/opportunities/opp_a', { method: 'DELETE' })).status).toBe(403);
    expect((await app('opportunities:delete').request('/api/opportunities/opp_b', { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/opportunities/opp_a', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/opportunities/opp_a', { method: 'DELETE' })).status).toBe(404);
  });
});

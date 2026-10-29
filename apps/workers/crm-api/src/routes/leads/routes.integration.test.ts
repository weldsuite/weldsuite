/**
 * Every /api/leads route on pglite, refusals included (validation, owner
 * scope, not found, permission), qualify and both convert paths. The
 * conformance suite runs these against the Rust backend too.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { leadsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.crmLeads).values([
    { id: 'lead_ann', email: 'ann@acme.test', firstName: 'Ann', lastName: 'Lee', fullName: 'Ann Lee', companyName: 'Acme', status: 'new', source: 'web', rating: 'hot', ownerId: 'user_test_default', budget: { amount: 5000, currency: 'USD' }, campaign: 'spring', createdAt: at(1), updatedAt: at(1) },
    { id: 'lead_bob', email: 'bob@beta.test', firstName: 'Bob', status: 'contacted', source: 'referral', ownerId: 'user_other', isQualified: true, createdAt: at(2), updatedAt: at(2) },
    { id: 'lead_cy', email: 'cy@gamma.test', status: 'new', source: 'web', ownerId: 'user_test_default', createdAt: at(3), updatedAt: at(3) },
    { id: 'lead_gone', email: 'gone@x.test', status: 'new', source: 'web', ownerId: 'user_test_default', deletedAt: at(4), createdAt: at(4), updatedAt: at(4) },
  ]);
}, 60_000);

const ALL = ['leads:read', 'leads:create', 'leads:update', 'leads:delete', 'leads:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/leads', leadsRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/leads · every route', () => {
  it('lists with filters, search, the owner scope and a cursor', async () => {
    const res = await app().request('/api/leads?limit=2');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: { id: string }[]; pagination: { cursor: string; totalCount: number } };
    expect(page.data.map((l) => l.id)).toEqual(['lead_cy', 'lead_bob']);
    expect(page.pagination.totalCount).toBe(3);
    expect((await app().request(`/api/leads?limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/leads?status=new&source=web&rating=hot&ownerId=user_test_default')).status).toBe(200);
    expect((await app().request('/api/leads?isQualified=true')).status).toBe(200);
    expect((await app().request('/api/leads?isQualified=')).status).toBe(200);
    expect((await app().request('/api/leads?search=Lee')).status).toBe(200);
    expect((await app().request('/api/leads?search=acme&cursor=lead_missing')).status).toBe(200);
    expect((await app().request('/api/leads?cursor=lead_missing')).status).toBe(200);
    const own = await app('leads:read').request('/api/leads');
    expect(((await own.json()) as { data: { id: string }[] }).data.map((l) => l.id)).toEqual(['lead_cy', 'lead_ann']);
  });

  it('reads a lead within the owner scope', async () => {
    expect((await app().request('/api/leads/lead_bob')).status).toBe(200);
    expect((await app('leads:read').request('/api/leads/lead_bob')).status).toBe(404);
    expect((await app().request('/api/leads/lead_gone')).status).toBe(404);
  });

  it('creates leads and refuses a bad body', async () => {
    const res = await app().request('/api/leads', json('POST', { email: 'new@lead.test', firstName: 'New', score: 10, productInterest: ['crm'], address: { city: 'Ghent' }, ownerId: null }));
    expect(res.status).toBe(201);
    expect((await app().request('/api/leads', json('POST', { email: 'only@lead.test', lastName: 'Solo', authority: true }))).status).toBe(201);
    expect((await app().request('/api/leads', json('POST', { email: 'not-an-email' }))).status).toBe(400);
    expect((await app().request('/api/leads', json('POST', { firstName: 'No email', score: 1.5 }))).status).toBe(400);
  });

  it('updates names, status and email, and refuses unknown or out-of-scope leads', async () => {
    expect((await app().request('/api/leads/lead_cy', json('PATCH', { firstName: 'Cy', status: 'working' }))).status).toBe(200);
    expect((await app().request('/api/leads/lead_cy', json('PATCH', { lastName: '', firstName: '' }))).status).toBe(200);
    expect((await app().request('/api/leads/lead_cy', json('PATCH', { email: 'cy2@gamma.test', notes: 'n' }))).status).toBe(200);
    expect((await app().request('/api/leads/lead_cy', json('PATCH', { email: 'bad' }))).status).toBe(400);
    expect((await app('leads:update').request('/api/leads/lead_bob', json('PATCH', { status: 'x' }))).status).toBe(404);
    expect((await app().request('/api/leads/lead_missing', json('PATCH', { status: 'x' }))).status).toBe(404);
  });

  it('qualifies a lead', async () => {
    const res = await app().request('/api/leads/lead_cy/qualify', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'lead_cy', isQualified: true, status: 'qualified' } });
    expect((await app().request('/api/leads/lead_missing/qualify', { method: 'POST' })).status).toBe(404);
  });

  it('converts a lead to a customer and a deal, or neither', async () => {
    const res = await app().request('/api/leads/lead_ann/convert', json('POST', { createCustomer: true, createOpportunity: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { leadId: string; customerId?: string; opportunityId?: string } };
    expect(body.data.leadId).toBe('lead_ann');
    expect(body.data.customerId).toMatch(/^pty_/);
    expect(body.data.opportunityId).toMatch(/^opp_/);
    const bare = await app().request('/api/leads/lead_bob/convert', json('POST', { createCustomer: false }));
    expect(await bare.json()).toEqual({ data: { leadId: 'lead_bob' } });
    expect((await app().request('/api/leads/lead_cy/convert', json('POST', {}))).status).toBe(200);
    expect((await app().request('/api/leads/lead_cy/convert', json('POST', { createCustomer: 'yes' }))).status).toBe(400);
    expect((await app().request('/api/leads/lead_missing/convert', json('POST', {}))).status).toBe(404);
  });

  it('deletes a lead and refuses without the permission', async () => {
    expect((await app('leads:read').request('/api/leads', json('POST', { email: 'x@y.test' }))).status).toBe(403);
    expect((await app('leads:read').request('/api/leads/lead_cy', json('PATCH', {}))).status).toBe(403);
    expect((await app('leads:read').request('/api/leads/lead_cy/qualify', { method: 'POST' })).status).toBe(403);
    expect((await app('leads:read').request('/api/leads/lead_cy/convert', json('POST', {}))).status).toBe(403);
    expect((await app('leads:read').request('/api/leads/lead_cy', { method: 'DELETE' })).status).toBe(403);
    expect((await app().request('/api/leads/lead_cy', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/leads/lead_cy', { method: 'DELETE' })).status).toBe(404);
  });
});

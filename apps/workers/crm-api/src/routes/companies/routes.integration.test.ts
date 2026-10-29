/**
 * The /api/companies routes the main integration test leaves out: archive,
 * people, bulk-update, the detail aggregate, navigation, refresh-logo
 * without storage, the record chat forward without chat-api, sorting,
 * filters and the refusals. Runs against the Rust backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { companiesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_1', userId: 'user_test_default', email: 'me@x.test', role: 'ADMIN', status: 'ACTIVE', createdAt: at(0), updatedAt: at(0) },
    { id: 'wm_2', userId: 'user_owner', email: 'owner@x.test', role: 'MEMBER', status: 'ACTIVE', createdAt: at(0), updatedAt: at(0) },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_tier', entityType: 'company', name: 'Tier', slug: 'tier', fieldType: 'text', required: false, sortOrder: 0, createdAt: at(0), updatedAt: at(0) },
    { id: 'cfld_size', entityType: 'company', name: 'Size', slug: 'size', fieldType: 'number', required: false, sortOrder: 1, createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.companies).values([
    { id: 'company_acme', name: 'Acme', displayName: 'Acme', industry: 'Tools', status: 'active', ownerId: 'user_test_default', leadScore: 5, createdAt: at(1), updatedAt: at(1) },
    { id: 'company_beta', name: 'Beta', displayName: 'Beta', industry: 'Tools', status: 'prospect', ownerId: 'user_owner', isSupplier: true, createdAt: at(2), updatedAt: at(2) },
    { id: 'company_gamma', name: 'gamma', displayName: 'gamma', email: 'hi@gamma.test', ownerId: 'user_test_default', isLead: true, createdAt: at(3), updatedAt: at(3) },
  ]);
  await db.insert(schema.customFieldValues).values([
    { id: 'cfv_a', fieldId: 'cfld_tier', entityType: 'company', entityId: 'company_acme', valueText: 'gold', createdAt: at(1), updatedAt: at(1) },
    { id: 'cfv_b', fieldId: 'cfld_size', entityType: 'company', entityId: 'company_beta', valueNumber: 50, createdAt: at(1), updatedAt: at(1) },
  ]);
  await db.insert(schema.people).values([
    { id: 'person_ann', firstName: 'Ann', displayName: 'Ann', email: 'ann@acme.test', createdAt: at(1), updatedAt: at(1) },
    { id: 'person_gone', firstName: 'Gone', displayName: 'Gone', deletedAt: at(2), createdAt: at(1), updatedAt: at(1) },
  ]);
  await db.insert(schema.personCompanies).values([
    { id: 'pc_1', personId: 'person_ann', companyId: 'company_acme', isPrimary: true, createdAt: at(1), updatedAt: at(1) },
    { id: 'pc_2', personId: 'person_gone', companyId: 'company_acme', createdAt: at(2), updatedAt: at(2) },
  ]);
  await db.insert(schema.parties).values({
    id: 'party_acme', kind: 'company', companyId: 'company_acme', role: 'customer', displayName: 'Acme', createdAt: at(1), updatedAt: at(1),
  } as typeof schema.parties.$inferInsert);
  await db.insert(schema.crmActivities).values([
    { id: 'act_1', type: 'call', subject: 'Call', status: 'completed', assignedToId: 'user_test_default', counterpartyId: 'party_acme', createdAt: at(5), updatedAt: at(5) },
    { id: 'act_2', type: 'note', subject: 'Note', status: 'planned', assignedToId: 'user_test_default', counterpartyId: 'party_acme', createdAt: at(6), updatedAt: at(6) },
  ]);
  await db.insert(schema.crmOpportunities).values({
    id: 'opp_1', name: 'Deal', customerId: 'company_acme', counterpartyId: 'party_acme', amount: '1500.00', ownerId: 'user_test_default', createdAt: at(4), updatedAt: at(4),
  });
  await db.insert(schema.lists).values({ id: 'list_key', name: 'Key', kind: 'company', type: 'static', createdAt: at(1), updatedAt: at(1) });
  await db.insert(schema.listMembers).values([
    { id: 'lm_1', listId: 'list_key', entityId: 'company_acme', addedAt: at(7) },
    { id: 'lm_2', listId: 'list_key', entityId: 'company_gamma', addedAt: at(8) },
  ]);
}, 60_000);

const ALL = ['companies:read', 'companies:create', 'companies:update', 'companies:delete', 'companies:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/companies', companiesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/companies · more routes', () => {
  it('sorts by built-in and custom fields, pages with offsets, and filters', async () => {
    const byName = await app().request('/api/companies?sort=name&sortDir=asc&limit=2');
    const page = (await byName.json()) as { data: { id: string }[]; pagination: { cursor: string } };
    expect(page.data.map((c) => c.id)).toEqual(['company_acme', 'company_beta']);
    expect((await app().request(`/api/companies?sort=name&sortDir=asc&limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/companies?sort=leadScore&sortDir=desc')).status).toBe(200);
    expect((await app().request('/api/companies?sort=isSupplier')).status).toBe(200);
    expect((await app().request('/api/companies?sort=createdAt&sortDir=asc')).status).toBe(200);
    expect((await app().request('/api/companies?sort=custom:tier')).status).toBe(200);
    expect((await app().request('/api/companies?sort=custom:size&sortDir=desc')).status).toBe(200);
    expect((await app().request('/api/companies?sort=unknown')).status).toBe(200);
    expect((await app().request('/api/companies?customFilter=tier:gol')).status).toBe(200);
    expect((await app().request('/api/companies?customFilter=size:abc')).status).toBe(200);
    expect((await app().request('/api/companies?customFilter=nope')).status).toBe(200);
    expect((await app().request('/api/companies?listId=list_key&industry=Tools&isSupplier=&isLead=false')).status).toBe(200);
    expect((await app().request('/api/companies?listId=list_missing')).status).toBe(200);
    expect((await app().request('/api/companies?status=active&ownerId=user_test_default&search=a_c')).status).toBe(200);
    expect((await app('companies:read').request('/api/companies')).status).toBe(200);
    expect((await app().request('/api/companies?limit=500')).status).toBe(400);
    expect((await app().request('/api/companies?sortDir=up&include=all')).status).toBe(400);
    expect((await app().request('/api/companies/export?listId=list_key')).status).toBe(200);
  });

  it('archives, unarchives and lists the people of a company', async () => {
    expect((await app().request('/api/companies/company_beta/archive', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/companies/company_beta/unarchive', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/companies/company_missing/archive', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/companies/company_missing/unarchive', { method: 'POST' })).status).toBe(404);
    const people = await app().request('/api/companies/company_acme/people');
    expect(((await people.json()) as { data: { personId: string }[] }).data.map((p) => p.personId)).toEqual(['person_ann']);
    expect(await (await app('companies:read').request('/api/companies/company_beta/people')).json()).toEqual({ data: [] });
  });

  it('reads the detail aggregate and navigation', async () => {
    const detail = await app().request('/api/companies/company_acme/detail?activitiesLimit=1');
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { data: { counts: Record<string, number>; activities: unknown[] } };
    expect(body.data.counts).toMatchObject({ people: 2, activities: 2, notes: 1, opportunities: 1 });
    expect(body.data.activities).toHaveLength(1);
    expect((await app().request('/api/companies/company_gamma/detail')).status).toBe(200);
    expect((await app().request('/api/companies/company_missing/detail')).status).toBe(404);
    expect((await app().request('/api/companies/company_acme/detail?peopleLimit=99')).status).toBe(400);
    expect((await app().request('/api/companies/company_beta/navigation')).status).toBe(200);
    expect((await app().request('/api/companies/company_acme/navigation?listId=list_key')).status).toBe(200);
    expect((await app().request('/api/companies/company_beta/navigation?listId=list_key')).status).toBe(200);
    expect((await app().request('/api/companies/company_missing/navigation')).status).toBe(404);
  });

  it('bulk-updates safe fields and refuses bad input', async () => {
    const res = await app().request('/api/companies/bulk-update', json('POST', { companyIds: ['company_acme', 'company_gamma', 'company_missing', 'company_acme'], updates: { status: 'inactive', lifecycleStage: 'customer', ownerId: 'user_owner' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 2, failed: [{ id: 'company_missing', reason: 'Not found or already deleted' }] } });
    expect((await app().request('/api/companies/bulk-update', json('POST', { companyIds: ['company_acme'], updates: {} }))).status).toBe(400);
    expect((await app().request('/api/companies/bulk-update', json('POST', { companyIds: [], updates: { status: 'x' } }))).status).toBe(400);
    expect((await app().request('/api/companies/bulk-update', json('POST', { companyIds: ['company_acme'], updates: { status: 'made-up' } }))).status).toBe(400);
    expect((await app().request('/api/companies/bulk-update', json('POST', { companyIds: ['company_acme'], updates: { lifecycleStage: 'nope' } }))).status).toBe(400);
    expect((await app().request('/api/companies/bulk-update', json('POST', { companyIds: ['company_acme'], updates: { ownerId: 'user_nobody' } }))).status).toBe(400);
  });

  it('updates with custom fields, money and addresses, and refuses bad values', async () => {
    const res = await app().request('/api/companies/company_gamma', json('PATCH', {
      tradingName: 'Gamma Trading', website: 'gamma.test', annualRevenue: { amount: 1000, currency: 'EUR' },
      customFields: { tier: 'silver', size: 7 }, addresses: [{ city: 'Ghent', extra: true }], employeeCount: '11-50',
      lastContactDate: '2026-02-01', foundationDate: null, isSupplier: true, version: 1,
    }));
    expect(res.status).toBe(200);
    expect((await app().request('/api/companies/company_gamma', json('PATCH', { email: 5, website: 'nodot', employeeCount: 'many', annualRevenue: { amount: -1, currency: 'EU' } }))).status).toBe(400);
    expect((await app().request('/api/companies/company_gamma', json('PATCH', { email: 'bad', ifVersion: 0 }))).status).toBe(400);
    expect((await app().request('/api/companies/company_gamma', json('PATCH', { email: '', twitterFollowerCount: -1, alternateEmails: ['x'] }))).status).toBe(400);
    expect((await app().request('/api/companies/company_gamma', json('PATCH', { accountManagerId: 'user_nobody' }))).status).toBe(400);
    expect((await app('companies:update').request('/api/companies/company_beta', json('PATCH', { name: 'x' }))).status).toBe(404);
  });

  it('refreshes no logo without storage, and answers 503 for chats without chat-api', async () => {
    expect((await app().request('/api/companies/company_acme/refresh-logo', { method: 'POST' })).status).toBe(500);
    const chat = app();
    expect((await chat.request('/api/companies/company_acme/chat/channel')).status).toBe(503);
    expect((await chat.request('/api/companies/company_acme/chat/messages', json('POST', { content: 'hi' }))).status).toBe(503);
    expect((await chat.request('/api/companies/company_acme/chat/follow', { method: 'POST' })).status).toBe(503);
    expect((await chat.request('/api/companies/company_acme/chat/follow', { method: 'DELETE' })).status).toBe(503);
  });

  it('refuses without the permission', async () => {
    const reader = app('companies:read');
    expect((await reader.request('/api/companies/company_acme/archive', { method: 'POST' })).status).toBe(403);
    expect((await reader.request('/api/companies/bulk-update', json('POST', { companyIds: ['x'], updates: { status: 'x' } }))).status).toBe(403);
    expect((await reader.request('/api/companies/import', json('POST', { records: [{ name: 'x' }] }))).status).toBe(403);
    expect((await reader.request('/api/companies/company_acme/refresh-logo', { method: 'POST' })).status).toBe(403);
    expect((await app('companies:update').request('/api/companies/company_acme/detail')).status).toBe(403);
  });
});

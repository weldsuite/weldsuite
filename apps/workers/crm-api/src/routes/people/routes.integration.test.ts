/**
 * The /api/people routes the main integration test leaves out: the list's
 * filters, sorts and pages, export, resolve-by-emails, the importer's
 * matches and row errors, recent correspondents without a mailbox, the
 * owner scope, archive, add-to-crm, the company links, bulk-update, the
 * detail aggregate, navigation and the refusals. Runs against the Rust
 * backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { peopleRoutes } from './index';
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
    { id: 'cfld_tier', entityType: 'person', name: 'Tier', slug: 'tier', fieldType: 'text', required: false, sortOrder: 0, createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.people).values([
    { id: 'person_ann', firstName: 'Ann', lastName: 'Archer', displayName: 'Ann Archer', email: 'ann@acme.test', title: 'CEO', status: 'active', ownerId: 'user_test_default', directPhone: '+3210', leadScore: 7, createdAt: at(1), updatedAt: at(10) },
    { id: 'person_bob', firstName: 'bob', displayName: 'bob', email: 'Bob@Beta.test', status: 'lead', ownerId: 'user_owner', isLead: true, mobilePhone: '  ', createdAt: at(2), updatedAt: at(9) },
    { id: 'person_cy', fullName: 'Cy Cole', displayName: 'Cy Cole', ownerId: 'user_test_default', isSupplier: true, inCrm: false, createdAt: at(3), updatedAt: at(8) },
    { id: 'person_hidden', displayName: 'guest@mail.test', email: 'guest@mail.test', inCrm: false, createdAt: at(4), updatedAt: at(7) },
    { id: 'person_gone', firstName: 'Gone', displayName: 'Gone', email: 'gone@acme.test', deletedAt: at(5), createdAt: at(5), updatedAt: at(5) },
    { id: 'person_old', firstName: 'Old', displayName: 'Old', email: 'old@acme.test', archivedAt: at(6), createdAt: at(6), updatedAt: at(11) },
  ]);
  await db.insert(schema.customFieldValues).values([
    { id: 'cfv_a', fieldId: 'cfld_tier', entityType: 'person', entityId: 'person_ann', valueText: 'gold', createdAt: at(1), updatedAt: at(1) },
  ]);
  await db.insert(schema.companies).values([
    { id: 'company_acme', name: 'Acme', displayName: 'Acme', industry: 'Tools', createdAt: at(1), updatedAt: at(1) },
    { id: 'company_beta', name: 'Beta', displayName: 'Beta', createdAt: at(2), updatedAt: at(2) },
    { id: 'company_gone', name: 'Gone Co', displayName: 'Gone Co', deletedAt: at(3), createdAt: at(3), updatedAt: at(3) },
  ]);
  await db.insert(schema.personCompanies).values([
    { id: 'pc_1', personId: 'person_ann', companyId: 'company_acme', isPrimary: true, role: 'Founder', createdAt: at(1), updatedAt: at(1) },
    { id: 'pc_2', personId: 'person_ann', companyId: 'company_gone', createdAt: at(2), updatedAt: at(2) },
    { id: 'pc_3', personId: 'person_bob', companyId: 'company_acme', endedAt: at(3), createdAt: at(3), updatedAt: at(3) },
  ]);
  await db.insert(schema.lists).values([
    { id: 'list_vip', name: 'VIP', kind: 'person', type: 'static', createdAt: at(1), updatedAt: at(1) },
    { id: 'list_cos', name: 'Companies', kind: 'company', type: 'static', createdAt: at(1), updatedAt: at(1) },
    { id: 'list_empty', name: 'Empty', kind: 'person', type: 'static', createdAt: at(1), updatedAt: at(1) },
  ]);
  await db.insert(schema.listMembers).values([
    { id: 'lm_1', listId: 'list_vip', entityId: 'person_ann', addedAt: at(7) },
    { id: 'lm_2', listId: 'list_vip', entityId: 'person_bob', addedAt: at(8) },
  ]);
  await db.insert(schema.crmActivities).values([
    { id: 'act_1', type: 'call', subject: 'Call', status: 'completed', assignedToId: 'user_test_default', personId: 'person_ann', createdAt: at(5), updatedAt: at(5) },
    { id: 'act_2', type: 'note', subject: 'Note', status: 'planned', assignedToId: 'user_test_default', personId: 'person_ann', createdAt: at(6), updatedAt: at(6) },
    { id: 'act_3', type: 'task', subject: 'Task', status: 'planned', assignedToId: 'user_test_default', personId: 'person_ann', createdAt: at(7), updatedAt: at(7) },
  ]);
  await db.insert(schema.helpdeskTickets).values({
    id: 'tkt_1', ticketNumber: 'T-1', customerName: 'Ann', customerEmail: 'ann@acme.test', subject: 'Help', personId: 'person_ann', createdAt: at(8), updatedAt: at(8),
  } as typeof schema.helpdeskTickets.$inferInsert);
}, 60_000);

const ALL = ['people:read', 'people:create', 'people:update', 'people:delete', 'people:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/people', peopleRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const ids = async (res: Response) => ((await res.json()) as { data: { id: string }[] }).data.map((p) => p.id);

describe('/api/people · more routes', () => {
  it('lists with filters, sorts and pages', async () => {
    expect(await ids(await app().request('/api/people'))).toEqual(['person_old', 'person_hidden', 'person_cy', 'person_bob', 'person_ann']);
    const first = await app().request('/api/people?limit=2');
    const page = (await first.json()) as { data: { id: string }[]; pagination: { cursor: string; totalCount: number } };
    expect(page.pagination.totalCount).toBe(5);
    expect((await app().request(`/api/people?limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/people?cursor=person_missing')).status).toBe(200);
    const byName = await app().request('/api/people?sort=name&sortDir=asc&limit=2');
    const sorted = (await byName.json()) as { data: { id: string }[]; pagination: { cursor: string } };
    expect(sorted.data.map((p) => p.id)).toEqual(['person_ann', 'person_bob']);
    expect((await app().request(`/api/people?sort=name&sortDir=asc&limit=2&cursor=${sorted.pagination.cursor}`)).status).toBe(200);
    for (const sort of ['title&sortDir=desc', 'email', 'isLead&sortDir=desc', 'isDecisionMaker', 'leadScore&sortDir=desc', 'createdAt', 'nextFollowUpDate&sortDir=desc', 'custom:tier', 'unknown']) {
      expect((await app().request(`/api/people?sort=${sort}`)).status).toBe(200);
    }
    expect(await ids(await app().request('/api/people?search=ARCH'))).toEqual(['person_ann']);
    expect(await ids(await app().request('/api/people?status=lead&isLead=true'))).toEqual(['person_bob']);
    expect(await ids(await app().request('/api/people?inCrm=&isSupplier=true'))).toEqual(['person_cy']);
    expect(await ids(await app().request('/api/people?hasPhone=true'))).toEqual(['person_ann']);
    expect((await app().request('/api/people?hasPhone=&ownerId=user_owner')).status).toBe(200);
    expect(await ids(await app().request('/api/people?companyId=company_acme'))).toEqual(['person_ann']);
    expect(await ids(await app().request('/api/people?companyId=company_none'))).toEqual([]);
    expect(await ids(await app().request('/api/people?listId=list_vip'))).toEqual(['person_bob', 'person_ann']);
    expect(await ids(await app().request('/api/people?listId=list_cos'))).toEqual([]);
    expect(await ids(await app().request('/api/people?listId=list_empty'))).toEqual([]);
    expect(await ids(await app('people:read').request('/api/people'))).not.toContain('person_bob');
    expect((await app().request('/api/people?limit=500')).status).toBe(400);
    expect((await app().request('/api/people?sortDir=up')).status).toBe(400);
  });

  it('exports every match and resolves addresses', async () => {
    expect(await ids(await app().request('/api/people/export?listId=list_vip&sort=name&inCrm=true'))).toEqual(['person_bob', 'person_ann']);
    expect((await app('people:read').request('/api/people/export?search=a')).status).toBe(200);
    expect((await app().request('/api/people/export?sortDir=sideways')).status).toBe(400);
    const resolved = await app().request('/api/people/resolve-by-emails', json('POST', { emails: ['bob@beta.test', 'ANN@acme.test', 'gone@acme.test', 'nobody@x.test'] }));
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { data: { id: string }[] }).data.map((p) => p.id).sort()).toEqual(['person_ann', 'person_bob']);
    expect((await app().request('/api/people/resolve-by-emails', json('POST', { emails: [] }))).status).toBe(400);
    expect((await app().request('/api/people/resolve-by-emails', json('POST', { emails: ['not-an-email'] }))).status).toBe(400);
  });

  it('suggests recent correspondents without a mailbox', async () => {
    const res = await app().request('/api/people/recent-correspondents?limit=2');
    expect(await ids(res)).toEqual(['person_ann', 'person_bob']);
    expect((await app().request('/api/people/recent-correspondents?accountId=')).status).toBe(200);
    expect((await app().request('/api/people/recent-correspondents?accountId=mail_missing')).status).toBe(403);
    expect((await app().request('/api/people/recent-correspondents?limit=0')).status).toBe(400);
  });

  it('reads one person within the owner scope', async () => {
    const res = await app().request('/api/people/person_ann');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { customFields: Record<string, unknown> } }).data.customFields).toEqual({ tier: 'gold' });
    expect((await app('people:read').request('/api/people/person_bob')).status).toBe(404);
    expect((await app().request('/api/people/person_gone')).status).toBe(404);
  });

  it('creates with company links, custom fields and a supplier party, and refuses bad input', async () => {
    const res = await app().request('/api/people', json('POST', {
      firstName: ' Dee ', lastName: 'Dunn', email: 'dee@acme.test', linkedinUrl: 'linkedin.com/in/dee', dateOfBirth: '1990-04-01T00:00:00Z',
      isSupplier: true, companyIds: ['company_acme', 'company_beta'], primaryCompanyId: 'company_beta', customFields: { tier: 'silver' },
      primaryAddress: { city: 'Ghent', extra: 1 }, tags: ['a'], accountManagerId: 'user_owner', inCrm: true,
    }));
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: { id: string; fullName: string; linkedinUrl: string; customFields: unknown } }).data;
    expect(created.linkedinUrl).toBe('https://linkedin.com/in/dee');
    expect((await app().request(`/api/people/${created.id}/companies`)).status).toBe(200);
    expect((await app().request('/api/people', json('POST', { fullName: 'No Email', email: '' }))).status).toBe(201);
    expect((await app().request('/api/people', json('POST', { email: 'ann@acme.test' }))).status).toBe(409);
    expect((await app().request('/api/people', json('POST', { email: 'guest@mail.test', inCrm: false }))).status).toBe(409);
    expect((await app().request('/api/people', json('POST', { firstName: 'X', ownerId: 'user_nobody' }))).status).toBe(400);
    expect((await app().request('/api/people', json('POST', { firstName: 5, email: 'nope', linkedinUrl: 'nodot', dateOfBirth: '2020-01-01', lifecycleStage: 'zzz' }))).status).toBe(400);
    expect((await app().request('/api/people', json('POST', { email: null }))).status).toBe(400);
    expect((await app().request('/api/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
  });

  it('promotes a hidden identity with its company links', async () => {
    const res = await app().request('/api/people', json('POST', {
      firstName: 'Guest', email: 'GUEST@mail.test', companyIds: ['company_acme'], primaryCompanyId: 'company_acme', nextFollowUpDate: '2026-03-01',
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string; inCrm: boolean } }).data).toMatchObject({ id: 'person_hidden', inCrm: true });
  });

  it('updates names, dates, versions and addresses', async () => {
    const ok = await app().request('/api/people/person_cy', json('PATCH', {
      lastName: 'Cole', dateOfBirth: '1980-01-01T00:00:00Z', nextFollowUpDate: '2026-02-01', primaryAddress: null, version: 1, customFields: { tier: 'bronze' },
    }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { displayName: string; fullName: string } }).data).toMatchObject({ displayName: 'Cole', fullName: 'Cole' });
    expect((await app().request('/api/people/person_cy', json('PATCH', { ifVersion: 1, title: 'x' }))).status).toBe(409);
    expect((await app().request('/api/people/person_cy', json('PATCH', { fullName: 'Cyrus Cole', nextFollowUpDate: null, ifVersion: 2 }))).status).toBe(200);
    expect((await app().request('/api/people/person_cy', json('PATCH', { email: 'BOB@beta.test' }))).status).toBe(409);
    expect((await app().request('/api/people/person_cy', json('PATCH', { email: '', isSupplier: false }))).status).toBe(200);
    expect((await app().request('/api/people/person_missing', json('PATCH', { title: 'x' }))).status).toBe(404);
    expect((await app('people:update').request('/api/people/person_bob', json('PATCH', { title: 'x' }))).status).toBe(404);
    expect((await app().request('/api/people/person_cy', json('PATCH', { version: 0, accountManagerId: 7 }))).status).toBe(400);
    expect((await app().request('/api/people/person_cy', json('PATCH', { ownerId: 'user_nobody' }))).status).toBe(400);
  });

  it('imports: matches by party code and email, merges custom fields, reports row errors', async () => {
    const res = await app().request('/api/people/import', json('POST', {
      records: [
        { partyCode: 'P-1', firstName: 'Imp', lastName: 'One', email: 'imp1@imp.test', customFields: { tier: 'x' }, isSupplier: true },
        { email: 'ANN@acme.test', title: 'Chair', customFields: { extra: 1 } },
        { partyCode: 'P-1', title: 'Again' },
        { title: 'Nobody' },
        { firstName: 'Bad', dateOfBirth: 'not a date' },
        { email: 'bob@beta.test', dateOfBirth: 'not a date' },
        { fullName: 'Dated', dateOfBirth: '2001-02-03', unknown: true },
      ],
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imported: number; updated: number; failed: number; errors: unknown[] } };
    expect(body.data).toMatchObject({ imported: 2, updated: 2, failed: 3 });
    expect((await app().request('/api/people/import', json('POST', { records: [] }))).status).toBe(400);
    expect((await app().request('/api/people/import', json('POST', { records: [{ partyCode: 5 }] }))).status).toBe(400);
  });

  it('archives, unarchives, adds to the CRM and deletes', async () => {
    expect((await app().request('/api/people/person_bob/archive', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/people/person_bob/unarchive', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/people/person_missing/archive', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/people/person_missing/unarchive', { method: 'POST' })).status).toBe(404);
    await db.insert(schema.people).values({ id: 'person_unowned', displayName: 'u@mail.test', email: 'u@mail.test', inCrm: false, createdAt: new Date(Date.UTC(2026, 0, 1, 10)), updatedAt: new Date(Date.UTC(2026, 0, 1, 10)) });
    const added = await app('people:update').request('/api/people/person_unowned/add-to-crm', { method: 'POST' });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { data: { ownerId: string; inCrm: boolean } }).data).toMatchObject({ ownerId: 'user_test_default', inCrm: true });
    expect((await app('people:update').request('/api/people/person_bob/add-to-crm', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/people/person_bob/add-to-crm', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/people/person_unowned', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/people/person_unowned', { method: 'DELETE' })).status).toBe(404);
    expect((await app('people:delete').request('/api/people/person_bob', { method: 'DELETE' })).status).toBe(404);
  });

  it('lists company links within the scope', async () => {
    const res = await app().request('/api/people/person_ann/companies');
    expect(((await res.json()) as { data: { companyId: string }[] }).data.map((c) => c.companyId)).toEqual(['company_acme']);
    expect(await (await app('people:read').request('/api/people/person_bob/companies')).json()).toEqual({ data: [] });
  });

  it('bulk-updates safe fields and refuses bad input', async () => {
    const res = await app().request('/api/people/bulk-update', json('POST', { personIds: ['person_ann', 'person_old', 'person_missing', 'person_ann'], updates: { status: 'vip', lifecycleStage: 'customer', ownerId: 'user_owner' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 2, failed: [{ id: 'person_missing', reason: 'Not found or already deleted' }] } });
    expect((await app('people:update').request('/api/people/bulk-update', json('POST', { personIds: ['person_ann'], updates: { accountManagerId: null } }))).status).toBe(200);
    expect((await app().request('/api/people/bulk-update', json('POST', { personIds: ['person_ann'], updates: {} }))).status).toBe(400);
    expect((await app().request('/api/people/bulk-update', json('POST', { personIds: [], updates: { status: 'x' } }))).status).toBe(400);
    expect((await app().request('/api/people/bulk-update', json('POST', { personIds: ['person_ann'], updates: { lifecycleStage: 'nope' } }))).status).toBe(400);
    expect((await app().request('/api/people/bulk-update', json('POST', { personIds: ['person_ann'], updates: { ownerId: 'user_nobody' } }))).status).toBe(400);
  });

  it('reads the detail aggregate and navigation', async () => {
    const detail = await app().request('/api/people/person_ann/detail?activitiesLimit=2');
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { data: { counts: Record<string, number>; activities: unknown[]; tickets: unknown[] } };
    expect(body.data.counts).toMatchObject({ companies: 2, activities: 3, tickets: 1, notes: 1, tasks: 1 });
    expect(body.data.activities).toHaveLength(2);
    expect((await app().request('/api/people/person_cy/detail?companiesLimit=1&ticketsLimit=1')).status).toBe(200);
    expect((await app().request('/api/people/person_missing/detail')).status).toBe(404);
    expect((await app().request('/api/people/person_ann/detail?ticketsLimit=99')).status).toBe(400);
    expect((await app().request('/api/people/person_bob/navigation')).status).toBe(200);
    expect((await app('people:read').request('/api/people/person_cy/navigation')).status).toBe(200);
    expect((await app().request('/api/people/person_ann/navigation?listId=list_vip')).status).toBe(200);
    expect((await app().request('/api/people/person_cy/navigation?listId=list_vip')).status).toBe(200);
    expect((await app().request('/api/people/person_ann/navigation?listId=list_missing')).status).toBe(200);
    expect((await app().request('/api/people/person_missing/navigation')).status).toBe(404);
  });

  it('answers 503 for the record chat without chat-api', async () => {
    expect((await app().request('/api/people/person_ann/chat/channel')).status).toBe(503);
    expect((await app().request('/api/people/person_ann/chat/messages', json('POST', { content: 'hi' }))).status).toBe(503);
    expect((await app().request('/api/people/person_ann/chat/follow', { method: 'POST' })).status).toBe(503);
    expect((await app().request('/api/people/person_ann/chat/follow', { method: 'DELETE' })).status).toBe(503);
  });

  it('refuses without the permission', async () => {
    expect((await app('companies:read').request('/api/people')).status).toBe(403);
    expect((await app('people:read').request('/api/people', json('POST', { firstName: 'X' }))).status).toBe(403);
    expect((await app('people:read').request('/api/people/import', json('POST', { records: [{ firstName: 'X' }] }))).status).toBe(403);
    expect((await app('people:read').request('/api/people/person_ann', json('PATCH', { title: 'x' }))).status).toBe(403);
    expect((await app('people:read').request('/api/people/person_ann', { method: 'DELETE' })).status).toBe(403);
    expect((await app('people:read').request('/api/people/bulk-update', json('POST', { personIds: ['person_ann'], updates: { status: 'x' } }))).status).toBe(403);
    expect((await app('people:create').request('/api/people/resolve-by-emails', json('POST', { emails: ['a@b.test'] }))).status).toBe(403);
  });
});

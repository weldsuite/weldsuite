import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import {
  companies,
  listMembers,
  lists,
  people,
  personCompanies,
  reachEnrollments,
  reachProspectListMembers,
  reachProspectLists,
  reachProspects,
  reachSuppressions,
  welddataLeads,
  welddataLists,
} from '@weldsuite/db/schema';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

const dns = vi.hoisted(() => ({ lookupRecord: vi.fn() }));
vi.mock('@weldsuite/worker-kit/dns-lookup', () => ({ lookupRecord: (...args: unknown[]) => dns.lookupRecord(...args) }));

import { publishEntityEvent } from '@weldsuite/entity-events';
import prospectRoutes, { MAX_IMPORT_EVENTS } from './index';
import { reachApp, asJson, readJson } from '../../test-support/routes';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect } from '../../test-support/reach';
import type { ReachImportReport, ReachProspect } from '@weldsuite/app-api-client/schemas/reach';

const publish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

const app = (permissions: string[] = ['reach_prospects:read', 'reach_prospects:create', 'reach_prospects:update', 'reach_prospects:delete', 'lists:read', 'people:read'], limits = {}) =>
  reachApp('/api/reach/prospects', prospectRoutes, { permissions, db, limits });

const MX_LESS = new Set(['nomx.test']);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  await db.delete(listMembers);
  await db.delete(personCompanies);
  await db.delete(people);
  await db.delete(companies);
  await db.delete(lists);
  await db.delete(welddataLeads);
  await db.delete(welddataLists);
  publish.mockClear();
  dns.lookupRecord.mockReset();
  dns.lookupRecord.mockImplementation(async (domain: string) => (MX_LESS.has(domain) ? [] : [{ name: domain, type: 'MX', value: 'mx.' + domain, ttl: 60, priority: 10 }]));
});

const importRows = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  app().request('/api/reach/prospects/import', asJson('POST', { rows, ...extra }));

describe('POST /import', () => {
  it('rejects a file that has a row without an email property', async () => {
    expect((await importRows([{ email: 'a@bigco.io' }, { firstName: 'No email column' }])).status).toBe(400);
    expect(await db.select().from(reachProspects)).toHaveLength(0);
  });

  it('imports a realistic file: lower-cases emails, verdicts by column, skipped counts by reason', async () => {
    await db.insert(reachSuppressions).values({ id: 'rsup_1', value: 'blocked@bigco.io', type: 'email', reason: 'unsubscribed' });
    const res = await importRows(
      [
        { email: 'jane.doe@bigco.io', firstName: 'Jane', lastName: 'Doe', companyName: 'BigCo', title: 'CTO', customFields: { city: 'Utrecht' } },
        { email: 'JOHN@Other.IO ', firstName: 'John' },
        { email: 'someone@gmail.com' },
        { email: 'info@bigco.io' },
        { email: 'x@nomx.test' },
        { email: 'blocked@bigco.io' },
        { email: 'broken@' },
        { email: 'jane.doe@bigco.io' },
        { email: 'not an email' },
      ],
      { listName: 'October import', sourceRef: 'october.csv' },
    );

    expect(res.status).toBe(200);
    const { data: report } = await readJson<{ data: ReachImportReport }>(res);
    expect(report.created).toBe(7);
    expect(report.updated).toBe(0);
    expect(report.listId).toMatch(/^rpl_/);
    const skipped = Object.fromEntries(report.skipped.map((s) => [s.reason, s.count]));
    expect(skipped).toEqual({ consumer: 1, role: 1, no_mx: 1, suppressed: 1, invalid: 1, duplicate: 1, invalid_row: 1 });

    const rows = await db.select().from(reachProspects);
    const by = Object.fromEntries(rows.map((r) => [r.email, r.validation]));
    expect(by).toEqual({
      'jane.doe@bigco.io': 'valid',
      'john@other.io': 'valid',
      'someone@gmail.com': 'consumer',
      'info@bigco.io': 'role',
      'x@nomx.test': 'no_mx',
      'blocked@bigco.io': 'suppressed',
      'broken@': 'invalid',
    });
    const jane = rows.find((r) => r.email === 'jane.doe@bigco.io');
    expect(jane).toMatchObject({
      firstName: 'Jane',
      companyName: 'BigCo',
      companyDomain: 'bigco.io',
      title: 'CTO',
      source: 'csv',
      sourceRef: 'october.csv',
      customFields: { city: 'Utrecht' },
    });

    // the list holds every stored prospect, and its count says so
    const [list] = await db.select().from(reachProspectLists);
    expect(list).toMatchObject({ name: 'October import', prospectCount: 7, source: 'csv', sourceRef: 'october.csv' });
    expect(await db.select().from(reachProspectListMembers)).toHaveLength(7);
  });

  it('upserts by email: an existing prospect is updated, not duplicated, and keeps what the file leaves blank', async () => {
    await seedProspect(db, { email: 'jane@bigco.io', firstName: 'Jane', companyName: 'Old Name', customFields: { city: 'Utrecht' } });

    const res = await importRows([{ email: 'Jane@BigCo.io', companyName: 'BigCo', title: 'CTO', customFields: { country: 'NL' } }]);

    const { data } = await readJson<{ data: ReachImportReport }>(res);
    expect(data).toMatchObject({ created: 0, updated: 1 });
    const rows = await db.select().from(reachProspects);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: 'Jane', companyName: 'BigCo', title: 'CTO', customFields: { city: 'Utrecht', country: 'NL' } });
  });

  it('revives a deleted prospect when the same address is imported again', async () => {
    const gone = await seedProspect(db, { email: 'back@bigco.io', deletedAt: new Date() });
    const { data } = await readJson<{ data: ReachImportReport }>(await importRows([{ email: 'back@bigco.io' }]));
    expect(data.updated).toBe(1);
    const [row] = await db.select().from(reachProspects).where(eq(reachProspects.id, gone.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('lets consumer addresses through when staff allowed them for the workspace', async () => {
    const res = await app(undefined, { allowConsumerRecipients: true }).request('/api/reach/prospects/import', asJson('POST', { rows: [{ email: 'someone@gmail.com' }] }));
    const { data } = await readJson<{ data: ReachImportReport }>(res);
    expect(data.skipped).toEqual([]);
    expect((await db.select().from(reachProspects))[0]?.validation).toBe('valid');
  });

  it('looks up each domain once and never more than a few at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    dns.lookupRecord.mockImplementation(async (domain: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [{ name: domain, type: 'MX', value: 'mx', ttl: 60, priority: 10 }];
    });
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => ({ email: `user${i}@shared-domain.io` })),
      ...Array.from({ length: 30 }, (_, i) => ({ email: `person@company${i}.io` })),
    ];
    await importRows(rows);
    expect(dns.lookupRecord).toHaveBeenCalledTimes(31);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it('leaves an address valid when the DNS lookup itself fails', async () => {
    dns.lookupRecord.mockRejectedValue(new Error('DoH down'));
    await importRows([{ email: 'jane@bigco.io' }]);
    expect((await db.select().from(reachProspects))[0]?.validation).toBe('valid');
  });

  it('adds to an existing list, and answers 404 for one that does not exist', async () => {
    const [list] = await db.insert(reachProspectLists).values({ id: 'rpl_existing', name: 'Existing' }).returning();
    const ok = await importRows([{ email: 'a@bigco.io' }, { email: 'b@bigco.io' }], { listId: list!.id });
    expect(ok.status).toBe(200);
    expect((await db.select().from(reachProspectLists))[0]?.prospectCount).toBe(2);
    expect((await importRows([{ email: 'c@bigco.io' }], { listId: 'rpl_nope' })).status).toBe(404);
    expect(await db.select().from(reachProspects)).toHaveLength(2);
  });

  it('rejects more than 5000 rows and an empty file', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ email: `u${i}@bigco.io` }));
    expect((await importRows(rows)).status).toBe(400);
    expect((await importRows([])).status).toBe(400);
  });

  it('publishes reach_prospect:created for the new prospects, up to a cap', async () => {
    const rows = Array.from({ length: MAX_IMPORT_EVENTS + 20 }, (_, i) => ({ email: `u${i}@bigco.io` }));
    await importRows(rows);
    const created = publish.mock.calls.filter(([arg]) => (arg as { entityType: string; action: string }).entityType === 'reach_prospect' && (arg as { action: string }).action === 'created');
    expect(created).toHaveLength(MAX_IMPORT_EVENTS);
    expect(await db.select().from(reachProspects)).toHaveLength(MAX_IMPORT_EVENTS + 20);
  });

  it('is refused without the create permission', async () => {
    const res = await app(['reach_prospects:read']).request('/api/reach/prospects/import', asJson('POST', { rows: [{ email: 'a@bigco.io' }] }));
    expect(res.status).toBe(403);
  });
});

describe('POST /import-crm-list', () => {
  async function seedCrmList(kind = 'person', type = 'static') {
    await db.insert(lists).values({ id: 'list_crm', name: 'Conference leads', kind, type });
    await db.insert(companies).values([
      { id: 'comp_1', name: 'BigCo BV', displayName: 'BigCo' },
      { id: 'comp_2', name: 'Old Employer', displayName: 'Old Employer' },
    ]);
    await db.insert(people).values([
      { id: 'pers_1', displayName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', email: 'jane@bigco.io', title: 'CTO' },
      { id: 'pers_2', displayName: 'Bob Builder', email: 'bob@other.io' },
      { id: 'pers_3', displayName: 'No Email' },
      { id: 'pers_4', displayName: 'Deleted Dan', email: 'dan@gone.io', deletedAt: new Date() },
    ]);
    await db.insert(personCompanies).values([
      { id: 'pc_1', personId: 'pers_1', companyId: 'comp_2', isPrimary: false, endedAt: new Date('2024-01-01') },
      { id: 'pc_2', personId: 'pers_1', companyId: 'comp_1', isPrimary: true },
    ]);
    await db.insert(listMembers).values(['pers_1', 'pers_2', 'pers_3', 'pers_4'].map((id) => ({ id: `lm_${id}`, listId: 'list_crm', entityId: id })));
  }

  it('imports the people of a CRM list with their current primary company, linked to the person', async () => {
    await seedCrmList();
    const res = await app().request('/api/reach/prospects/import-crm-list', asJson('POST', { crmListId: 'list_crm' }));

    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: ReachImportReport }>(res);
    expect(data).toMatchObject({ created: 2, updated: 0 });
    const rows = await db.select().from(reachProspects);
    expect(rows.map((r) => r.email).sort()).toEqual(['bob@other.io', 'jane@bigco.io']);
    expect(rows.find((r) => r.email === 'jane@bigco.io')).toMatchObject({
      source: 'crm_list',
      sourceRef: 'list_crm',
      personId: 'pers_1',
      firstName: 'Jane',
      lastName: 'Doe',
      title: 'CTO',
      companyName: 'BigCo',
    });
    expect(rows.find((r) => r.email === 'bob@other.io')).toMatchObject({ firstName: 'Bob', lastName: 'Builder', personId: 'pers_2' });
    // a list is created, named after the CRM list
    expect((await db.select().from(reachProspectLists))[0]).toMatchObject({ name: 'Conference leads', source: 'crm_list', prospectCount: 2 });
  });

  it('answers 404, 400 and 403 for a missing list, a company list, a smart list and a user without CRM access', async () => {
    expect((await app().request('/api/reach/prospects/import-crm-list', asJson('POST', { crmListId: 'nope' }))).status).toBe(404);

    await seedCrmList('company');
    expect((await app().request('/api/reach/prospects/import-crm-list', asJson('POST', { crmListId: 'list_crm' }))).status).toBe(400);
    await db.update(lists).set({ kind: 'person', type: 'smart' });
    expect((await app().request('/api/reach/prospects/import-crm-list', asJson('POST', { crmListId: 'list_crm' }))).status).toBe(400);

    const noCrm = app(['reach_prospects:create']);
    expect((await noCrm.request('/api/reach/prospects/import-crm-list', asJson('POST', { crmListId: 'list_crm' }))).status).toBe(403);
  });
});

describe('POST /import-welddata', () => {
  it('imports the person leads of a WeldData list that have an email', async () => {
    await db.insert(welddataLists).values({ id: 'wdl_1', name: 'Dutch CTOs', kind: 'person' });
    await db.insert(welddataLeads).values([
      { id: 'wdlead_1', listId: 'wdl_1', kind: 'person', name: 'Anna van der Berg', email: 'anna@startup.nl', title: 'CTO', companyName: 'Startup BV', country: 'NL', industry: 'Software' },
      { id: 'wdlead_2', listId: 'wdl_1', kind: 'person', name: 'No Email' },
      { id: 'wdlead_3', listId: 'wdl_1', kind: 'person', name: 'Deleted', email: 'del@x.nl', deletedAt: new Date() },
    ]);

    const res = await app().request('/api/reach/prospects/import-welddata', asJson('POST', { welddataListId: 'wdl_1', listName: 'WeldData CTOs' }));

    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: ReachImportReport }>(res);
    expect(data.created).toBe(1);
    const [row] = await db.select().from(reachProspects);
    expect(row).toMatchObject({
      email: 'anna@startup.nl',
      firstName: 'Anna',
      lastName: 'van der Berg',
      title: 'CTO',
      companyName: 'Startup BV',
      source: 'welddata',
      sourceRef: 'wdl_1',
      customFields: { country: 'NL', industry: 'Software' },
    });
    expect((await db.select().from(reachProspectLists))[0]).toMatchObject({ name: 'WeldData CTOs', source: 'welddata' });
  });

  it('answers 404 for a missing list and 400 for a company list', async () => {
    expect((await app().request('/api/reach/prospects/import-welddata', asJson('POST', { welddataListId: 'nope' }))).status).toBe(404);
    await db.insert(welddataLists).values({ id: 'wdl_c', name: 'Companies', kind: 'company' });
    expect((await app().request('/api/reach/prospects/import-welddata', asJson('POST', { welddataListId: 'wdl_c' }))).status).toBe(400);
  });
});

describe('CRUD', () => {
  it('POST / creates a prospect with its verdict, adds it to a list and publishes the event; a duplicate is a 409', async () => {
    const [list] = await db.insert(reachProspectLists).values({ id: 'rpl_a', name: 'A' }).returning();
    const res = await app().request('/api/reach/prospects', asJson('POST', { email: 'New@BigCo.io', firstName: 'New', listId: list!.id }));

    expect(res.status).toBe(201);
    const { data } = await readJson<{ data: ReachProspect }>(res);
    expect(data).toMatchObject({ email: 'new@bigco.io', firstName: 'New', validation: 'valid', source: 'manual' });
    expect(data.id).toMatch(/^rpro_/);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'reach_prospect', action: 'created', entityId: data.id }));
    expect((await db.select().from(reachProspectLists))[0]?.prospectCount).toBe(1);

    expect((await app().request('/api/reach/prospects', asJson('POST', { email: 'new@bigco.io' }))).status).toBe(409);
    expect((await app().request('/api/reach/prospects', asJson('POST', { email: 'x@bigco.io', listId: 'rpl_nope' }))).status).toBe(404);
    expect((await app().request('/api/reach/prospects', asJson('POST', { email: 'nope' }))).status).toBe(400);
  });

  it('GET / lists newest first with filters, search and cursor pagination', async () => {
    const a = await seedProspect(db, { email: 'anna@bigco.io', firstName: 'Anna', companyName: 'BigCo' });
    await seedProspect(db, { email: 'info@bigco.io', firstName: null, validation: 'role' });
    await seedProspect(db, { email: 'carl@other.io', firstName: 'Carl', companyName: 'Other' });
    await seedProspect(db, { email: 'gone@other.io', deletedAt: new Date() });
    await db.insert(reachProspectLists).values({ id: 'rpl_a', name: 'A' });
    await db.insert(reachProspectListMembers).values({ id: 'rplm_a', listId: 'rpl_a', prospectId: a.id });

    const all = await readJson<{ data: ReachProspect[]; pagination: { totalCount: number } }>(await app().request('/api/reach/prospects'));
    expect(all.data).toHaveLength(3);
    expect(all.pagination.totalCount).toBe(3);

    const search = await readJson<{ data: ReachProspect[] }>(await app().request('/api/reach/prospects?search=bigco'));
    expect(search.data.map((p) => p.email).sort()).toEqual(['anna@bigco.io', 'info@bigco.io']);
    const role = await readJson<{ data: ReachProspect[] }>(await app().request('/api/reach/prospects?validation=role'));
    expect(role.data.map((p) => p.email)).toEqual(['info@bigco.io']);
    const inList = await readJson<{ data: ReachProspect[] }>(await app().request('/api/reach/prospects?listId=rpl_a'));
    expect(inList.data.map((p) => p.email)).toEqual(['anna@bigco.io']);
    expect((await app().request('/api/reach/prospects?validation=bogus')).status).toBe(400);

    const first = await readJson<{ data: ReachProspect[]; pagination: { hasMore: boolean; cursor: string | null } }>(await app().request('/api/reach/prospects?limit=2'));
    expect(first.data).toHaveLength(2);
    expect(first.pagination.hasMore).toBe(true);
    const second = await readJson<{ data: ReachProspect[]; pagination: { hasMore: boolean } }>(await app().request(`/api/reach/prospects?limit=2&cursor=${first.pagination.cursor}`));
    expect(second.data).toHaveLength(1);
    expect(second.pagination.hasMore).toBe(false);
    expect(new Set([...first.data, ...second.data].map((p) => p.id)).size).toBe(3);
  });

  it('GET /:id and PATCH /:id', async () => {
    const p = await seedProspect(db, { email: 'p@bigco.io', firstName: 'P', title: 'Old' });
    expect((await app().request(`/api/reach/prospects/${p.id}`)).status).toBe(200);
    expect((await app().request('/api/reach/prospects/rpro_nope')).status).toBe(404);

    const res = await app().request(`/api/reach/prospects/${p.id}`, asJson('PATCH', { title: 'CTO', companyName: '', customFields: { a: 'b' } }));
    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: ReachProspect }>(res);
    expect(data).toMatchObject({ title: 'CTO', firstName: 'P', companyName: null, customFields: { a: 'b' } });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'reach_prospect', action: 'updated', entityId: p.id }));
    expect((await app().request('/api/reach/prospects/rpro_nope', asJson('PATCH', { title: 'x' }))).status).toBe(404);
  });

  it('DELETE /:id removes the prospect from lists, stops its enrollments and completes the campaign that had nothing else', async () => {
    const p = await seedProspect(db);
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, p.id);
    await db.insert(reachProspectLists).values({ id: 'rpl_a', name: 'A', prospectCount: 1 });
    await db.insert(reachProspectListMembers).values({ id: 'rplm_a', listId: 'rpl_a', prospectId: p.id });

    const res = await app().request(`/api/reach/prospects/${p.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    const [row] = await db.select().from(reachProspects).where(eq(reachProspects.id, p.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(await db.select().from(reachProspectListMembers)).toHaveLength(0);
    expect((await db.select().from(reachProspectLists))[0]?.prospectCount).toBe(0);
    const [e] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(e).toMatchObject({ status: 'failed', stoppedReason: 'prospect_deleted' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'reach_prospect', action: 'deleted', entityId: p.id }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'reach_campaign', action: 'completed', entityId: campaign.id }));
    expect((await app().request(`/api/reach/prospects/${p.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

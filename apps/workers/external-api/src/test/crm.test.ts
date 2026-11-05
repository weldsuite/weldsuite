/**
 * WeldCRM's objects through the public API, beyond the contract matrix and
 * the CRUD round-trips: the list filters, the derived names, the defaults a
 * create fills in, the opportunity transitions and their events, the routes
 * the round-trips can't reach (opportunities and quotes need a parent or an
 * inline schema), and the refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // A worker's files share one pglite: another file may have added the member.
  await db
    .insert(schema.workspaceMembers)
    .values({
      id: 'wm_crm_actor',
      userId: 'user_test',
      role: 'ADMIN',
    } as typeof schema.workspaceMembers.$inferInsert)
    .onConflictDoNothing();
}, 60_000);

function api(scopes: string[] = ['*']) {
  return createExternalTestApp({ scopes, tenantDb: db });
}

/** A workspace key: no member behind it. */
function workspaceKey() {
  const session: ApiKeySession = {
    keyId: 'key_ws',
    keyType: 'workspace',
    workspaceId: 'ws_test',
    userId: null,
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    licensedApps: null,
  };
  return createExternalTestApp({ session, tenantDb: db });
}

async function post(path: string, body: unknown, app = api()) {
  return app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

async function patch(path: string, body: unknown, app = api()) {
  return app.request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

describe('external-api · people', () => {
  it('derives the names, filters the list, and recomputes the display name', async () => {
    const created = await post('/v1/people', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      dateOfBirth: '1815-12-10T00:00:00Z',
      isSupplier: true,
      linkedinUrl: 'linkedin.com/in/ada',
    });
    expect(created.status).toBe(201);
    const person = await data<{ id: string; fullName: string; displayName: string; linkedinUrl: string }>(created);
    expect(person.fullName).toBe('Ada Lovelace');
    expect(person.linkedinUrl).toBe('https://linkedin.com/in/ada');

    const onlyEmail = await post('/v1/people', { email: '  solo@example.com ' });
    expect(onlyEmail.status).toBe(400);
    const unnamed = await post('/v1/people', { email: '' });
    expect(unnamed.status).toBe(201);
    expect((await data<{ displayName: string }>(unnamed)).displayName).toBe('Unnamed');

    const search = await api().request('/v1/people?search=Lovel&isSupplier=true&limit=5');
    expect(search.status).toBe(200);
    const found = (await search.json()) as { data: { id: string }[]; pagination: { totalCount: number } };
    expect(found.data.map((p) => p.id)).toContain(person.id);

    const none = await api().request('/v1/people?companyId=co_none');
    expect(((await none.json()) as { data: unknown[] }).data).toEqual([]);
    const noList = await api().request('/v1/people?listId=list_none');
    expect(((await noList.json()) as { data: unknown[] }).data).toEqual([]);

    const renamed = await patch(`/v1/people/${person.id}`, { lastName: 'King', title: 'Countess' });
    expect(renamed.status).toBe(200);
    const after = await data<{ fullName: string; displayName: string }>(renamed);
    expect(after.displayName).toBe('Ada King');

    const badUrl = await patch(`/v1/people/${person.id}`, { linkedinUrl: 'not-a-url' });
    expect(badUrl.status).toBe(400);
    const tooLong = await api().request('/v1/people?limit=500');
    expect(tooLong.status).toBe(400);

    expect((await patch('/v1/people/person_missing', { title: 'x' })).status).toBe(404);
    expect((await api().request('/v1/people/person_missing', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('external-api · companies', () => {
  it('derives the display name and filters by industry and list', async () => {
    const created = await post('/v1/companies', {
      name: 'Acme',
      tradingName: '  Acme Trading ',
      industry: 'manufacturing',
      website: 'acme.example',
      employeeCount: '11-50',
    });
    expect(created.status).toBe(201);
    const company = await data<{ id: string; displayName: string; website: string }>(created);
    expect(company.displayName).toBe('Acme Trading');
    expect(company.website).toBe('https://acme.example');

    const byIndustry = await api().request('/v1/companies?industry=manufacturing&search=Acme');
    const page = (await byIndustry.json()) as { data: { id: string }[] };
    expect(page.data.map((c) => c.id)).toContain(company.id);

    const renamed = await patch(`/v1/companies/${company.id}`, { tradingName: '', ifVersion: 3 });
    expect(renamed.status).toBe(200);
    expect((await data<{ displayName: string }>(renamed)).displayName).toBe('Acme');

    const badCount = await patch(`/v1/companies/${company.id}`, { employeeCount: 'lots' });
    expect(badCount.status).toBe(400);
    expect((await api().request('/v1/companies?listId=list_none')).status).toBe(200);
  });
});

describe('external-api · custom fields in one request', () => {
  beforeAll(async () => {
    const definitions: (typeof schema.customFieldDefinitions.$inferInsert)[] = [
      {
        id: 'cfd_ext_co_tier',
        entityType: 'company',
        name: 'Tier',
        slug: 'ext_tier',
        fieldType: 'single_select',
        options: [
          { label: 'Gold', value: 'gold' },
          { label: 'Silver', value: 'silver' },
        ],
        sortOrder: 1,
      },
      { id: 'cfd_ext_co_seats', entityType: 'company', name: 'Seats', slug: 'ext_seats', fieldType: 'number', sortOrder: 2 },
      { id: 'cfd_ext_co_renewal', entityType: 'company', name: 'Renewal', slug: 'ext_renewal', fieldType: 'date', sortOrder: 3 },
      { id: 'cfd_ext_co_erp', entityType: 'company', name: 'ERP id', slug: 'ext_erp_id', fieldType: 'text', sortOrder: 4 },
      {
        id: 'cfd_ext_pe_size',
        entityType: 'person',
        name: 'Shirt size',
        slug: 'ext_shirt',
        fieldType: 'single_select',
        options: [
          { label: 'S', value: 's' },
          { label: 'M', value: 'm' },
        ],
      },
      { id: 'cfd_ext_pe_nps', entityType: 'person', name: 'NPS', slug: 'ext_nps', fieldType: 'number' },
    ];
    await db.insert(schema.customFieldDefinitions).values(definitions).onConflictDoNothing();
  });

  async function storedValues(entityId: string) {
    const rows = await db
      .select({ fieldId: schema.customFieldValues.fieldId })
      .from(schema.customFieldValues)
      .where(eq(schema.customFieldValues.entityId, entityId));
    return rows.map((r) => r.fieldId).sort();
  }

  it('lists the slugs a company and a person take', async () => {
    const companies = await api().request('/v1/companies/custom-fields');
    expect(companies.status).toBe(200);
    const list = (await companies.json()) as { data: { slug: string; fieldType: string }[] };
    expect(list.data.map((d) => d.slug)).toEqual(
      expect.arrayContaining(['ext_tier', 'ext_seats', 'ext_renewal', 'ext_erp_id']),
    );
    expect(list.data.find((d) => d.slug === 'ext_tier')?.fieldType).toBe('single_select');

    const people = await api().request('/v1/people/custom-fields');
    const peopleList = (await people.json()) as { data: { slug: string }[] };
    expect(peopleList.data.map((d) => d.slug)).toEqual(expect.arrayContaining(['ext_shirt', 'ext_nps']));

    expect((await api(['people:read']).request('/v1/companies/custom-fields')).status).toBe(403);
  });

  it('creates a company with its fields and custom fields in one POST, and merges on PATCH', async () => {
    const created = await post('/v1/companies', {
      name: 'Batch Metals BV',
      tradingName: 'Batch Metals',
      registrationNumber: '12345678',
      vatNumber: 'NL123456789B01',
      industry: 'metalworking',
      employeeCount: '51-200',
      website: 'batch.example',
      description: 'Sheet metal and welding',
      email: 'info@batch.example',
      phone: '+31 20 123 4567',
      mobile: '+31 6 1234 5678',
      primaryAddress: { line1: 'Kade 1', postalCode: '1011 AB', city: 'Amsterdam', country: 'NL' },
      status: 'customer',
      lifecycleStage: 'customer',
      segment: 'mid-market',
      rating: 'A',
      source: 'erp-sync',
      isSupplier: true,
      preferredLanguage: 'nl',
      timezone: 'Europe/Amsterdam',
      marketingConsent: true,
      tags: ['erp', 'priority'],
      notes: 'Imported from the ERP',
      customFields: {
        ext_tier: 'gold',
        ext_seats: '25',
        ext_renewal: '2027-01-31',
        ext_erp_id: 'ERP-1001',
        ext_unknown_key: 'kept in the record',
      },
    });
    expect(created.status).toBe(201);
    const company = await data<{
      id: string;
      displayName: string;
      vatNumber: string;
      tags: string[];
      primaryAddress: { city: string };
      customFields: Record<string, unknown>;
    }>(created);
    expect(company.displayName).toBe('Batch Metals');
    expect(company.vatNumber).toBe('NL123456789B01');
    expect(company.tags).toEqual(['erp', 'priority']);
    expect(company.primaryAddress.city).toBe('Amsterdam');
    expect(company.customFields).toEqual({
      ext_tier: 'gold',
      ext_seats: 25,
      ext_renewal: '2027-01-31T00:00:00.000Z',
      ext_erp_id: 'ERP-1001',
      ext_unknown_key: 'kept in the record',
    });
    // Written to the typed table WeldCRM reads, one row per defined field.
    expect(await storedValues(company.id)).toEqual(
      ['cfd_ext_co_erp', 'cfd_ext_co_renewal', 'cfd_ext_co_seats', 'cfd_ext_co_tier'],
    );

    const read = await api().request(`/v1/companies/${company.id}`);
    expect((await data<{ customFields: Record<string, unknown> }>(read)).customFields.ext_seats).toBe(25);
    const listed = await api().request('/v1/companies?search=Batch%20Metals');
    const page = (await listed.json()) as { data: { id: string; customFields: Record<string, unknown> }[] };
    expect(page.data.find((row) => row.id === company.id)?.customFields.ext_tier).toBe('gold');

    // PATCH changes only the keys it sends; null clears one.
    const patched = await patch(`/v1/companies/${company.id}`, {
      phone: '+31 20 765 4321',
      customFields: { ext_seats: 30, ext_erp_id: null },
    });
    expect(patched.status).toBe(200);
    const after = await data<{ phone: string; customFields: Record<string, unknown> }>(patched);
    expect(after.phone).toBe('+31 20 765 4321');
    expect(after.customFields).toEqual({
      ext_tier: 'gold',
      ext_seats: 30,
      ext_renewal: '2027-01-31T00:00:00.000Z',
      ext_unknown_key: 'kept in the record',
    });
    expect(await storedValues(company.id)).toEqual(['cfd_ext_co_renewal', 'cfd_ext_co_seats', 'cfd_ext_co_tier']);

    const badPatch = await patch(`/v1/companies/${company.id}`, { customFields: { ext_renewal: 'someday' } });
    expect(badPatch.status).toBe(400);
  });

  it('refuses every bad custom field value at once and writes nothing', async () => {
    const refused = await post('/v1/companies', {
      name: 'Refused Custom Co',
      customFields: { ext_tier: 'bronze', ext_seats: 'many', ext_erp_id: 'fine' },
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      error: { code: string; message: string; details: { field: string; errors: Record<string, string> } };
    };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.details.field).toBe('customFields');
    expect(body.error.details.errors).toEqual({
      ext_seats: "'ext_seats' must be a number",
      ext_tier: "'bronze' is not a valid option for 'ext_tier'",
    });
    const search = await api().request('/v1/companies?search=Refused%20Custom');
    expect(((await search.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('creates a person with custom fields and their company in one POST', async () => {
    const employer = await data<{ id: string }>(await post('/v1/companies', { name: 'Employer Co' }));
    const created = await post('/v1/people', {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@employer.example',
      title: 'Rear Admiral',
      department: 'Engineering',
      directPhone: '+1 555 0100',
      mobilePhone: '+1 555 0101',
      status: 'active',
      lifecycleStage: 'customer',
      isDecisionMaker: true,
      preferredLanguage: 'en',
      tags: ['cobol'],
      companyIds: [employer.id],
      primaryCompanyId: employer.id,
      customFields: { ext_shirt: 'm', ext_nps: 9 },
    });
    expect(created.status).toBe(201);
    const person = await data<{ id: string; displayName: string; customFields: Record<string, unknown> }>(created);
    expect(person.displayName).toBe('Grace Hopper');
    expect(person.customFields).toEqual({ ext_shirt: 'm', ext_nps: 9 });
    expect(await storedValues(person.id)).toEqual(['cfd_ext_pe_nps', 'cfd_ext_pe_size']);

    const staff = await api().request(`/v1/people?companyId=${employer.id}`);
    expect(((await staff.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toEqual([person.id]);
    const [link] = await db
      .select({ isPrimary: schema.personCompanies.isPrimary })
      .from(schema.personCompanies)
      .where(eq(schema.personCompanies.personId, person.id));
    expect(link?.isPrimary).toBe(true);

    const merged = await patch(`/v1/people/${person.id}`, { customFields: { ext_nps: '10' } });
    expect((await data<{ customFields: Record<string, unknown> }>(merged)).customFields).toEqual({
      ext_shirt: 'm',
      ext_nps: 10,
    });

    const unknownCompany = await post('/v1/people', { firstName: 'Nobody', companyIds: ['company_missing'] });
    expect(unknownCompany.status).toBe(400);
    const refusal = (await unknownCompany.json()) as { error: { details: { field: string; missing: string[] } } };
    expect(refusal.error.details).toEqual({ field: 'companyIds', missing: ['company_missing'] });

    const badValue = await post('/v1/people', { firstName: 'Bad', customFields: { ext_shirt: 'xxl' } });
    expect(badValue.status).toBe(400);
  });
});

describe('external-api · leads', () => {
  it('fills the defaults, falls back to the key owner, and renames', async () => {
    const created = await post('/v1/leads', { email: 'lead@example.com', firstName: 'Lee' });
    expect(created.status).toBe(201);
    const lead = await data<{ id: string; status: string; source: string; ownerId: string; fullName: string }>(created);
    expect(lead).toMatchObject({ status: 'new', source: 'other', ownerId: 'user_test', fullName: 'Lee' });

    const unowned = await post('/v1/leads', { email: 'ws@example.com', status: 'contacted' }, workspaceKey());
    expect(unowned.status).toBe(201);

    const filtered = await api().request('/v1/leads?status=new&search=lead@&isQualified=false');
    expect(filtered.status).toBe(200);

    const renamed = await patch(`/v1/leads/${lead.id}`, { lastName: 'Ray' });
    expect((await data<{ fullName: string }>(renamed)).fullName).toBe('Lee Ray');
    expect((await post('/v1/leads', { email: 'not-an-email' })).status).toBe(400);

    const removed = await api().request(`/v1/leads/${lead.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });
});

describe('external-api · opportunities', () => {
  let customerId: string;

  beforeAll(async () => {
    const company = await post('/v1/companies', { name: 'Deal Co' });
    customerId = (await data<{ id: string }>(company)).id;
  });

  it('creates with the defaults, moves through the stages, and deletes', async () => {
    const created = await post('/v1/opportunities', {
      name: 'Big deal',
      customerId,
      amount: 1200.5,
      expectedRevenue: '900',
      closeDate: '2026-12-31',
      nextStepDate: '2026-11-15T09:00:00Z',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const opp = await data<{ id: string; amount: string; currency: string; stage: string; pipeline: string }>(created);
    expect(opp).toMatchObject({ currency: 'EUR', stage: 'prospecting', pipeline: 'default' });

    const listed = await api().request(`/v1/opportunities?customerId=${customerId}&status=open&search=Big`);
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);

    const staged = await patch(`/v1/opportunities/${opp.id}`, { stage: 'proposal', amount: 1500, closeDate: '' });
    expect(staged.status).toBe(200);
    expect((await data<{ amount: string }>(staged)).amount).toBe('1500.00');

    const won = await patch(`/v1/opportunities/${opp.id}`, { status: 'won' });
    expect(won.status).toBe(200);
    const lost = await patch(`/v1/opportunities/${opp.id}`, { status: 'lost', currency: 'USD' });
    expect(lost.status).toBe(200);

    expect((await api().request(`/v1/opportunities/${opp.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api().request(`/v1/opportunities/${opp.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await patch(`/v1/opportunities/${opp.id}`, { stage: 'x' })).status).toBe(404);
  });

  it('refuses a bad amount, an unknown currency, and a workspace key without an owner', async () => {
    expect((await post('/v1/opportunities', { name: 'x', customerId, amount: -1 })).status).toBe(400);
    expect((await post('/v1/opportunities', { name: 'x', customerId, currency: 'XXX' })).status).toBe(400);
    expect((await post('/v1/opportunities', { name: 'x', customerId, closeDate: 'never' })).status).toBe(400);
    const noOwner = await post('/v1/opportunities', { name: 'x', customerId }, workspaceKey());
    expect(noOwner.status).toBe(400);
    const owned = await post('/v1/opportunities', { name: 'y', customerId, ownerId: 'user_test' }, workspaceKey());
    expect(owned.status).toBe(201);
  });
});

describe('external-api · pipelines and stages', () => {
  it('filters archived pipelines and the stages of one pipeline', async () => {
    const pipeline = await data<{ id: string }>(await post('/v1/pipelines', { name: 'Sales', description: null }));
    expect((await patch(`/v1/pipelines/${pipeline.id}`, { isArchived: true })).status).toBe(200);
    const active = await api().request('/v1/pipelines');
    expect(((await active.json()) as { data: { id: string }[] }).data.map((p) => p.id)).not.toContain(pipeline.id);
    const archived = await api().request('/v1/pipelines?archived=archived&search=Sal');
    expect(((await archived.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toContain(pipeline.id);
    expect((await api().request('/v1/pipelines?archived=all')).status).toBe(200);
    expect((await api().request('/v1/pipelines?archived=nope')).status).toBe(400);

    const stage = await post('/v1/pipeline-stages', { name: 'Qualify', pipeline: pipeline.id, probability: 20 });
    expect(stage.status).toBe(201);
    const stages = await api().request(`/v1/pipeline-stages?pipeline=${pipeline.id}`);
    expect(((await stages.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await post('/v1/pipeline-stages', { name: 'Bad', probability: 101 })).status).toBe(400);
    expect((await patch('/v1/pipeline-stages/pls_missing', { name: 'x' })).status).toBe(404);
    expect((await patch('/v1/pipelines/pl_missing', { name: 'x' })).status).toBe(404);
  });
});

describe('external-api · activities', () => {
  it('fills the defaults, completes, and refuses a workspace key without an assignee', async () => {
    const created = await post('/v1/activities', {
      type: 'call',
      subject: 'Intro call',
      dueDate: '2026-11-20T10:00:00Z',
      customerId: null,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const activity = await data<{ id: string; status: string; priority: string }>(created);
    expect(activity).toMatchObject({ status: 'planned', priority: 'medium' });

    const listed = await api().request('/v1/activities?type=call&search=Intro&assignedToId=user_test');
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);

    const done = await patch(`/v1/activities/${activity.id}`, { status: 'completed', endTime: '2026-11-20T11:00:00Z' });
    expect(done.status).toBe(200);
    const again = await patch(`/v1/activities/${activity.id}`, { status: 'completed' });
    expect(again.status).toBe(200);

    const noAssignee = await post('/v1/activities', { type: 'note', subject: 'x' }, workspaceKey());
    expect(noAssignee.status).toBe(400);
    expect((await post('/v1/activities', { type: 'fax', subject: 'x' })).status).toBe(400);
  });
});

describe('external-api · quotes', () => {
  it('cannot create one (the schema lacks the required customer), but updates, searches and deletes', async () => {
    // crm_quotes.customer_id is NOT NULL and the create schema has no
    // customerId, so every create fails in the database: the route's 500.
    const created = await post('/v1/quotes', {
      name: 'Q-0 Website',
      quoteNumber: 'Q-0',
      validFrom: '2026-11-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
      lineItems: [{ description: 'Design', amount: 100 }],
    });
    expect(created.status).toBe(500);
    expect((await post('/v1/quotes', { name: '' })).status).toBe(400);

    await db.insert(schema.crmQuotes).values({
      id: 'quote_seeded',
      quoteNumber: 'Q-1',
      name: 'Q-1 Website',
      customerId: 'co_seeded',
      lineItems: [],
      subtotal: '100.50',
      validFrom: new Date('2026-11-01T00:00:00Z'),
      validUntil: new Date('2026-12-01T00:00:00Z'),
    } as typeof schema.crmQuotes.$inferInsert);

    const updated = await patch('/v1/quotes/quote_seeded', { validUntil: '2026-12-15T00:00:00Z', notes: 'Net 30', currency: 'USD' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const listed = await api().request('/v1/quotes?search=Website');
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await api().request('/v1/quotes/quote_seeded')).status).toBe(200);

    expect((await patch('/v1/quotes/quote_seeded', { validFrom: 'tomorrow' })).status).toBe(400);
    expect((await api().request('/v1/quotes/quote_seeded', { method: 'DELETE' })).status).toBe(204);
    expect((await patch('/v1/quotes/quote_seeded', { notes: 'x' })).status).toBe(404);
    expect((await api().request('/v1/quotes/quote_seeded', { method: 'DELETE' })).status).toBe(404);
    expect((await api(['quotes:read']).request('/v1/quotes', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(403);
  });
});

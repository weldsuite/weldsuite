/**
 * WeldCRM's objects through the public API, beyond the contract matrix and
 * the CRUD round-trips: the list filters, the derived names, the defaults a
 * create fills in, the opportunity transitions and their events, the routes
 * the round-trips can't reach (opportunities and quotes need a parent or an
 * inline schema), and the refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_crm_actor',
    userId: 'user_test',
    role: 'ADMIN',
  } as typeof schema.workspaceMembers.$inferInsert);
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
      companyIds: ['co_unknown'],
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

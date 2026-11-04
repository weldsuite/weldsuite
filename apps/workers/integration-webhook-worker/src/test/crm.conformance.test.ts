/**
 * The CRM providers' webhooks end to end, through the worker's own `fetch`:
 * `POST /webhook/:connectionId` (Attio, and HubSpot through a connection's
 * own URL), `POST /webhook/hubspot` (the app URL, the connection found by
 * portal id) and `POST /webhook/gcal/:connectionId` (Google Calendar's push
 * notifications, which start a sync through connect-api's `CONNECT_INTERNAL`).
 * Signatures, the KV entries, the records fetched from the provider (a
 * `fetch` stub that answers by URL), the rows written and the entity events.
 * Run on both backends by the `integrations: crm` conformance suite.
 */

import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from './harness';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, tenantDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenantDb),
  getTenantDbForWorkspaceById: async () => conformanceTenantDb(holder.tenantDb),
}));

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let tenantDb: Db;
let masterDb: Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];

const WS = 'ws_crm';
const ATTIO_SECRET = 'attio-webhook-secret';
const HUBSPOT_SECRET = 'hubspot-client-secret';
const T0 = new Date('2026-10-01T09:00:00.000Z');

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? (JSON.parse(value) as unknown) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    store,
  };
}

function entry(provider: string, workspaceId = WS) {
  return JSON.stringify({ workspaceId, provider });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ATTIO = 'https://api.attio.com/v2';

/** The providers' APIs, by method and URL. */
function providerAnswer(method: string, url: string): Response {
  if (method === 'POST' && url === 'https://app.attio.com/oauth/token') {
    return json({ access_token: 'attio-fresh', token_type: 'bearer' });
  }
  const objects: Record<string, string> = { obj_co: 'companies', obj_pe: 'people', obj_co2: 'companies', obj_pe2: 'people', obj_x: 'deals' };
  for (const [id, slug] of Object.entries(objects)) {
    if (url === `${ATTIO}/objects/${id}`) return json({ data: { api_slug: slug } });
  }
  if (url === `${ATTIO}/objects/obj_missing`) return json({ message: 'nope' }, 404);
  const records: Record<string, unknown> = {
    [`${ATTIO}/objects/companies/records/rec_acme`]: {
      id: { record_id: 'rec_acme' },
      values: {
        name: [{ value: 'Acme BV' }],
        domains: [{ domain: 'acme.test' }],
        email_addresses: [{ email_address: 'hello@acme.test' }],
        description: [{ value: 'Widgets' }],
        categories: [{ option: { title: 'B2B' } }, { option: {} }],
      },
    },
    [`${ATTIO}/objects/people/records/rec_ada`]: {
      id: { record_id: 'rec_ada' },
      values: {
        name: [{ first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' }],
        email_addresses: [{ email_address: 'ada@acme.test' }],
        phone_numbers: [{ original_phone_number: '+31 20 123', phone_number: '+3120123' }],
        job_title: [{ value: 'CTO' }],
        company: [{ target_record_id: 'rec_acme' }],
      },
    },
    [`${ATTIO}/objects/people/records/rec_bob`]: {
      id: { record_id: 'rec_bob' },
      values: { name: [{ first_name: '', last_name: '' }], email_addresses: [{ email_address: 'bob@other.test' }] },
    },
    [`${ATTIO}/objects/companies/records/rec_dupe`]: {
      id: { record_id: 'rec_dupe' },
      values: { name: [{ value: 'Existing Co' }], email_addresses: [{ email_address: 'existing@co.test' }] },
    },
  };
  if (method === 'GET' && records[url]) return json({ data: records[url] });
  if (url === `${ATTIO}/objects/companies/records/rec_gone`) return json({ code: 'not_found' }, 404);
  if (url === `${ATTIO}/notes/note_1`) {
    return json({
      data: {
        id: { note_id: 'note_1' },
        parent_object: 'companies',
        parent_record_id: 'rec_acme',
        title: 'Kickoff',
        content_plaintext: 'Discussed the roadmap',
        created_at: '2026-10-02T10:00:00.000Z',
      },
    });
  }
  if (url === `${ATTIO}/tasks/task_1`) {
    return json({
      data: {
        id: { task_id: 'task_1' },
        content: 'Call Ada back',
        is_completed: false,
        deadline_at: '2026-10-09T12:00:00.000Z',
        linked_records: [{ target_object: 'people', target_record_id: 'rec_ada' }],
        assignees: [],
        created_at: '2026-10-02T10:00:00.000Z',
      },
    });
  }
  if (url === `${ATTIO}/lists/list_1/entries/entry_1`) {
    return json({ data: { id: { entry_id: 'entry_1', list_id: 'list_1' }, parent_record_id: 'rec_acme', parent_object: 'companies', entry_values: {} } });
  }
  if (url === `${ATTIO}/lists`) {
    return json({ data: [{ id: { list_id: 'list_1' }, name: 'Key accounts', api_slug: 'key', parent_object: 'companies' }] });
  }
  if (url.startsWith('https://api.hubapi.com/crm/v3/objects/companies/9001?')) {
    return json({ id: '9001', properties: { name: 'Hub Co', domain: 'hub.test', phone: null, description: 'From HubSpot' }, createdAt: '2026-10-01T09:00:00Z' });
  }
  if (url.startsWith('https://api.hubapi.com/crm/v3/objects/deals/77?')) {
    return json({ id: '77', properties: { dealname: 'Big deal', amount: '1000' }, updatedAt: '2026-10-03T09:00:00Z' });
  }
  if (url.startsWith('https://api.hubapi.com/crm/v3/objects/deals/78?')) return json({ message: 'gone' }, 404);
  return json({ message: `no stub for ${method} ${url}` }, 599);
}

function stubProviders() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return providerAnswer((init?.method ?? 'GET').toUpperCase(), url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function connectStub() {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/conn_gcal_down/')) return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
      return new Response(JSON.stringify({ data: { message: 'Sync started' } }), { status: 200 });
    }),
  };
}

async function seedConnection(values: Partial<typeof schema.integrationConnections.$inferInsert> & { id: string; provider: string }) {
  await tenantDb.insert(schema.integrationConnections).values({
    name: values.provider,
    status: 'active',
    oauthTokens: { accessToken: `token-${values.id}` },
    createdAt: T0,
    updatedAt: T0,
    ...values,
  } as typeof schema.integrationConnections.$inferInsert);
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.tenantDb = tenantDb;
  holder.masterDb = masterDb;
}, 60_000);

beforeEach(async () => {
  for (const table of [
    schema.integrationEntityMappings,
    schema.integrationConnections,
    schema.personCompanies,
    schema.listMembers,
    schema.lists,
    schema.crmActivities,
    schema.people,
    schema.companies,
  ]) {
    await tenantDb.delete(table);
  }
  await masterDb.delete(masterSchema.workspaces).where(eq(masterSchema.workspaces.id, 'ws_crm_hub'));
  await seedConnection({ id: 'conn_attio', provider: 'attio', webhookSecret: ATTIO_SECRET });
  await seedConnection({ id: 'conn_open', provider: 'attio' });
  await seedConnection({ id: 'conn_notoken', provider: 'attio', oauthTokens: null });
  await seedConnection({ id: 'conn_hub', provider: 'hubspot', externalAccountId: '62515', webhookSecret: HUBSPOT_SECRET });
  await seedConnection({
    id: 'conn_gcal',
    provider: 'google_calendar',
    webhookSecret: JSON.stringify({ token: 'channel-token', expiration: '1893456000000' }),
  });
  await seedConnection({ id: 'conn_gcal_down', provider: 'google_calendar' });
  await seedConnection({
    id: 'conn_expired',
    provider: 'attio',
    oauthTokens: { accessToken: 'attio-stale', refreshToken: 'attio-refresh', expiresAt: '2026-01-01T00:00:00.000Z' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The worker; `master` shares the master database (only HubSpot's portal scan reads it). */
function app(options: { kv?: ReturnType<typeof memoryKv>; env?: Record<string, unknown>; master?: boolean } = {}) {
  return createWebhookTestApp({
    masterDb: options.master ? masterDb : undefined,
    tenantDb,
    env: {
      WORKSPACE_CACHE:
        options.kv ??
        memoryKv({
          'intconn:conn_attio': entry('attio'),
          'intconn:conn_open': entry('attio'),
          'intconn:conn_notoken': entry('attio'),
          'intconn:conn_expired': entry('attio'),
          'intconn:conn_hub': entry('hubspot'),
          'intconn:conn_salesforce': entry('salesforce'),
          'intconn:conn_ghost': entry('attio'),
          'intconn:conn_gcal': entry('google_calendar'),
          'intconn:conn_gcal_down': entry('google_calendar'),
        }),
      ...options.env,
    },
  });
}

function attioSignature(body: string, secret = ATTIO_SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function deliverAttio(target: ReturnType<typeof app>, connectionId: string, events: unknown[], signed = true) {
  const body = JSON.stringify({ webhook_id: 'wh_1', events });
  return target.request(`/webhook/${connectionId}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...(signed ? { 'Attio-Signature': attioSignature(body) } : {}) },
  });
}

function record(event: string, objectId: string, recordId: string, extra: Record<string, unknown> = {}) {
  return { event_type: event, id: { workspace_id: 'aw', object_id: objectId, record_id: recordId }, ...extra };
}

async function mapping(externalType: string, externalId: string) {
  const [row] = await tenantDb
    .select()
    .from(schema.integrationEntityMappings)
    .where(and(eq(schema.integrationEntityMappings.externalEntityType, externalType), eq(schema.integrationEntityMappings.externalEntityId, externalId)));
  return row;
}

describe('POST /webhook/:connectionId', () => {
  it('refuses an unknown connection, an unknown provider, a forged signature and a connection without a token', async () => {
    stubProviders();
    const target = app();
    const missing = await deliverAttio(target, 'conn_nowhere', []);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Connection not found' });

    const unknown = await deliverAttio(target, 'conn_salesforce', []);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'Unknown provider' });

    const ghost = await deliverAttio(target, 'conn_ghost', []);
    expect(ghost.status).toBe(404);

    const forged = await target.request('/webhook/conn_attio', {
      method: 'POST',
      body: JSON.stringify({ events: [] }),
      headers: { 'Attio-Signature': attioSignature('{"events":[]}', 'wrong') },
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'Invalid signature' });

    const unsigned = await deliverAttio(target, 'conn_attio', [], false);
    expect(unsigned.status).toBe(401);

    const noToken = await deliverAttio(target, 'conn_notoken', []);
    expect(noToken.status).toBe(500);
    expect(await noToken.json()).toEqual({ error: 'No access token' });
  });

  it('upserts companies and people, links a person to its company, and counts them', async () => {
    const fetchMock = stubProviders();
    const target = app();
    const res = await deliverAttio(target, 'conn_attio', [
      record('record.created', 'obj_co', 'rec_acme'),
      record('record.created', 'obj_pe', 'rec_ada'),
      record('record.updated', 'obj_pe', 'rec_bob'),
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', processed: 3 });
    expect(fetchMock).toHaveBeenCalledWith(`${ATTIO}/objects/companies/records/rec_acme`, expect.anything());

    const companyMap = await mapping('company', 'rec_acme');
    const [company] = await tenantDb.select().from(schema.companies).where(eq(schema.companies.id, companyMap!.internalEntityId));
    expect(company).toMatchObject({ name: 'Acme BV', displayName: 'Acme BV', email: 'hello@acme.test', website: 'https://acme.test', notes: 'Widgets', source: 'attio' });
    const adaMap = await mapping('person', 'rec_ada');
    const [ada] = await tenantDb.select().from(schema.people).where(eq(schema.people.id, adaMap!.internalEntityId));
    expect(ada).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace', directPhone: '+31 20 123', title: 'CTO' });
    const links = await tenantDb.select().from(schema.personCompanies).where(eq(schema.personCompanies.personId, ada!.id));
    expect(links).toHaveLength(1);
    const bobMap = await mapping('person', 'rec_bob');
    const [bob] = await tenantDb.select().from(schema.people).where(eq(schema.people.id, bobMap!.internalEntityId));
    expect(bob).toMatchObject({ firstName: null, lastName: null, displayName: 'bob@other.test' });

    const [connection] = await tenantDb.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, 'conn_attio'));
    expect(connection).toMatchObject({ companiesSynced: 1, peopleSynced: 2 });

    // The same records again: nothing changed, so nothing is written.
    const again = await deliverAttio(target, 'conn_attio', [record('record.updated', 'obj_co', 'rec_acme')]);
    expect(again.status).toBe(200);
  });

  it('links a company to an existing one by email, merges and deletes records', async () => {
    stubProviders();
    await tenantDb.insert(schema.companies).values({ id: 'company_existing', name: 'Old name', displayName: 'Old name', email: 'existing@co.test' } as typeof schema.companies.$inferInsert);
    const target = app();
    const linked = await deliverAttio(target, 'conn_attio', [record('record.created', 'obj_co2', 'rec_dupe')]);
    expect(linked.status).toBe(200);
    expect((await mapping('company', 'rec_dupe'))?.internalEntityId).toBe('company_existing');
    const [renamed] = await tenantDb.select().from(schema.companies).where(eq(schema.companies.id, 'company_existing'));
    expect(renamed?.name).toBe('Existing Co');

    await deliverAttio(target, 'conn_attio', [record('record.created', 'obj_pe2', 'rec_bob')]);
    const merged = await deliverAttio(target, 'conn_attio', [
      record('record.merged', 'obj_pe2', 'rec_ada', { merged_from: { id: { record_id: 'rec_bob' } } }),
      record('record.deleted', 'obj_co2', 'rec_dupe'),
      record('record.deleted', 'obj_co2', 'rec_never_seen'),
    ]);
    expect(merged.status).toBe(200);
    const bobMap = await mapping('person', 'rec_bob');
    const [bob] = await tenantDb.select().from(schema.people).where(eq(schema.people.id, bobMap!.internalEntityId));
    expect(bob?.deletedAt).not.toBeNull();
    const [gone] = await tenantDb.select().from(schema.companies).where(eq(schema.companies.id, 'company_existing'));
    expect(gone?.deletedAt).not.toBeNull();
  });

  it('keeps notes, tasks and list entries as activities and list members', async () => {
    stubProviders();
    const target = app();
    await deliverAttio(target, 'conn_attio', [record('record.created', 'obj_co', 'rec_acme'), record('record.created', 'obj_pe', 'rec_ada')]);
    const res = await deliverAttio(target, 'conn_attio', [
      { event_type: 'note.created', id: { note_id: 'note_1' }, parent_object_id: 'obj_co', parent_record_id: 'rec_acme' },
      { event_type: 'task.created', id: { task_id: 'task_1' } },
      { event_type: 'list-entry.created', id: { list_id: 'list_1', entry_id: 'entry_1' }, parent_record_id: 'rec_acme' },
      { event_type: 'note.created', id: {} },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', processed: 4 });
    const noteMap = await mapping('note', 'note_1');
    const [note] = await tenantDb.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, noteMap!.internalEntityId));
    expect(note).toMatchObject({ type: 'note', subject: 'Kickoff', description: 'Discussed the roadmap', relatedTo: 'company' });
    const taskMap = await mapping('task', 'task_1');
    const [task] = await tenantDb.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, taskMap!.internalEntityId));
    expect(task).toMatchObject({ type: 'task', subject: 'Call Ada back', status: 'planned', relatedTo: 'person' });
    expect(await tenantDb.select().from(schema.listMembers)).toHaveLength(1);

    // The same list entry again links nothing new; then everything goes.
    const again = await deliverAttio(target, 'conn_attio', [{ event_type: 'list-entry.updated', id: { list_id: 'list_1', entry_id: 'entry_1' } }]);
    expect(again.status).toBe(200);
    const removed = await deliverAttio(target, 'conn_attio', [
      { event_type: 'note.deleted', id: { note_id: 'note_1' } },
      { event_type: 'task.deleted', id: { task_id: 'task_1' } },
      { event_type: 'list-entry.deleted', id: { list_id: 'list_1', entry_id: 'entry_1' } },
    ]);
    expect(removed.status).toBe(200);
    expect(await tenantDb.select().from(schema.listMembers)).toHaveLength(0);
    const [deletedNote] = await tenantDb.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, noteMap!.internalEntityId));
    expect(deletedNote?.deletedAt).not.toBeNull();
  });

  it('refreshes an expired token first, and answers a provider error with its message', async () => {
    const fetchMock = stubProviders();
    const target = app({ env: { ATTIO_CLIENT_ID: 'attio-client', ATTIO_CLIENT_SECRET: 'attio-secret' } });
    const res = await deliverAttio(target, 'conn_expired', [record('record.created', 'obj_co', 'rec_acme')]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://app.attio.com/oauth/token', expect.objectContaining({ method: 'POST' }));
    const [connection] = await tenantDb.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, 'conn_expired'));
    expect(connection?.oauthTokens).toEqual({ accessToken: 'attio-fresh', refreshToken: 'attio-refresh', tokenType: 'bearer' });

    // Without the OAuth client the stale token is used as it is.
    const stale = await deliverAttio(app(), 'conn_open', [record('record.created', 'obj_co', 'rec_gone')]);
    expect(stale.status).toBe(500);
    expect(await stale.json()).toEqual({ error: 'Attio API error 404: {"code":"not_found"}' });

    const unresolved = await deliverAttio(app(), 'conn_open', [record('record.created', 'obj_missing', 'rec_x')]);
    expect(unresolved.status).toBe(500);
  });

  it('takes a HubSpot delivery on a connection URL, by object type', async () => {
    stubProviders();
    const body = JSON.stringify([
      { portalId: 62515, objectId: 9001, objectTypeId: '0-2', subscriptionType: 'object.creation' },
      { portalId: 62515, objectId: 5, objectTypeId: '0-1', subscriptionType: 'object.propertyChange' },
    ]);
    const signature = createHash('sha256').update(HUBSPOT_SECRET + body).digest('hex');
    const res = await app().request('/webhook/conn_hub', { method: 'POST', body, headers: { 'X-HubSpot-Signature': signature } });
    expect(res.status).toBe(500);
    const companyMap = await mapping('company', '9001');
    const [company] = await tenantDb.select().from(schema.companies).where(eq(schema.companies.id, companyMap!.internalEntityId));
    expect(company).toMatchObject({ name: 'Hub Co', email: 'noemail-9001@placeholder.local', website: 'hub.test', source: 'hubspot' });
  });
});

describe('POST /webhook/hubspot', () => {
  function deliverHubspot(target: ReturnType<typeof app>, events: unknown[], secret = HUBSPOT_SECRET) {
    const body = JSON.stringify(events);
    return target.request('/webhook/hubspot', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'X-HubSpot-Signature-v3': createHash('sha256').update(secret + body).digest('hex') },
    });
  }

  it('refuses a delivery without a portal and a portal no workspace has', async () => {
    stubProviders();
    const empty = await deliverHubspot(app(), []);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'No portalId in payload' });

    const unknown = await deliverHubspot(app({ master: true }), [{ portalId: 404404, objectId: 1, objectTypeId: '0-3', subscriptionType: 'deal.creation' }]);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Portal not connected' });
  });

  it('finds the portal by scanning, caches it, and applies the events it can', async () => {
    stubProviders();
    await masterDb
      .insert(masterSchema.workspaces)
      .values({ id: 'ws_crm_hub', clerkOrgId: 'org_crm_hub', name: 'Hub', slug: 'hub' } as typeof masterSchema.workspaces.$inferInsert);
    await tenantDb.insert(schema.companies).values({ id: 'company_hub', name: 'Mapped', displayName: 'Mapped' } as typeof schema.companies.$inferInsert);
    await tenantDb.insert(schema.integrationEntityMappings).values({
      id: 'iem_hub',
      connectionId: 'conn_hub',
      externalEntityType: 'companies',
      externalEntityId: '31',
      internalEntityType: 'company',
      internalEntityId: 'company_hub',
    });
    const kv = memoryKv();
    const res = await deliverHubspot(app({ kv, master: true }), [
      { portalId: 62515, objectId: 77, objectTypeId: '0-3', subscriptionType: 'deal.creation' },
      { portalId: 62515, objectId: 78, objectTypeId: '0-3', subscriptionType: 'deal.propertyChange' },
      { portalId: 62515, objectId: 5, objectTypeId: '0-1', subscriptionType: 'contact.creation' },
      { portalId: 62515, objectId: 31, objectTypeId: '0-2', subscriptionType: 'company.deletion' },
      { portalId: 62515, objectId: 32, objectTypeId: '0-9', subscriptionType: 'ticket.creation' },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: 2 });
    expect(JSON.parse(kv.store.get('hubspot_portal:62515')!)).toMatchObject({ connectionId: 'conn_hub' });
    const [deleted] = await tenantDb.select().from(schema.companies).where(eq(schema.companies.id, 'company_hub'));
    expect(deleted?.deletedAt).not.toBeNull();

    const forged = await deliverHubspot(app({ kv }), [{ portalId: 62515, objectId: 77, objectTypeId: '0-3' }], 'wrong');
    expect(forged.status).toBe(401);
  });

  it('drops a cached portal whose connection is gone', async () => {
    stubProviders();
    const kv = memoryKv({ 'hubspot_portal:777': JSON.stringify({ workspaceId: WS, connectionId: 'conn_deleted' }) });
    const res = await deliverHubspot(app({ kv }), [{ portalId: 777, objectId: 1, objectTypeId: '0-3' }]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Connection not found' });
    expect(kv.store.has('hubspot_portal:777')).toBe(false);
  });
});

describe('POST /webhook/gcal/:connectionId', () => {
  function notify(target: ReturnType<typeof app>, connectionId: string, headers: Record<string, string>) {
    return target.request(`/webhook/gcal/${connectionId}`, { method: 'POST', headers });
  }

  it('acknowledges the handshake, and refuses an unknown connection and a wrong channel token', async () => {
    const connect = connectStub();
    const handshake = await notify(app({ env: { CONNECT_INTERNAL: connect } }), 'conn_unknown', { 'X-Goog-Resource-State': 'sync' });
    expect(handshake.status).toBe(200);
    expect(await handshake.json()).toEqual({ status: 'ok', type: 'sync_handshake' });

    const unknown = await notify(app({ env: { CONNECT_INTERNAL: connect } }), 'conn_unknown', { 'X-Goog-Resource-State': 'exists' });
    expect(unknown.status).toBe(404);

    const ghost = await notify(app({ env: { CONNECT_INTERNAL: connect }, kv: memoryKv({ 'intconn:conn_x': entry('google_calendar') }) }), 'conn_x', {
      'X-Goog-Resource-State': 'exists',
    });
    expect(ghost.status).toBe(404);

    const forged = await notify(app({ env: { CONNECT_INTERNAL: connect } }), 'conn_gcal', {
      'X-Goog-Resource-State': 'exists',
      'X-Goog-Channel-Token': 'not-the-token',
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'Invalid token' });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it('starts an incremental sync on a change, and only then', async () => {
    const connect = connectStub();
    const target = app({ env: { CONNECT_INTERNAL: connect } });
    const changed = await notify(target, 'conn_gcal', { 'X-Goog-Resource-State': 'exists', 'X-Goog-Channel-Token': 'channel-token' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ status: 'ok', type: 'sync_triggered' });
    expect(connect.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = connect.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://internal/api/integrations/connections/conn_gcal/sync');
    expect(JSON.parse(String(init.body))).toEqual({ syncType: 'incremental' });

    const gone = await notify(target, 'conn_gcal', { 'X-Goog-Resource-State': 'not_exists', 'X-Goog-Channel-Token': 'channel-token' });
    expect(gone.status).toBe(200);
    expect(connect.fetch).toHaveBeenCalledTimes(1);

    // A failed trigger is only logged; no binding at all only warns.
    const down = await notify(target, 'conn_gcal_down', { 'X-Goog-Resource-State': 'exists' });
    expect(down.status).toBe(200);
    const unbound = await notify(app(), 'conn_gcal', { 'X-Goog-Resource-State': 'exists', 'X-Goog-Channel-Token': 'channel-token' });
    expect(unbound.status).toBe(200);
  });
});

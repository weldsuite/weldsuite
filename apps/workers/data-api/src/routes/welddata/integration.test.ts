/**
 * /api/welddata on pglite: the Lemlist search (with its KV cache and the
 * saved-lead exclusion), lists, saved leads, converting leads into CRM
 * people and companies (and onto a CRM list), enrichment columns and cells,
 * and queueing enrichment runs on the `WELDDATA_ENRICH` Workflow (a fake,
 * shared with the Rust server in conformance mode).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { welddataRoutes } from './index';
import { createLemlistFetchStub, lemlistCallsSince } from '../../test/lemlist-stub';

const BASE = '/api/welddata';
const ALL = ['prospects:read', 'prospects:create', 'prospects:update', 'prospects:delete'];

let db: Database;
const kv = createMemoryKv();
const lemlist = createLemlistFetchStub();

/** The `WELDDATA_ENRICH` Workflow binding: answers by method, never by order. */
const enrich = {
  create: vi.fn(async (_options: unknown) => ({ id: 'wf_instance' })),
  get: vi.fn(async (id: string) => ({ id })),
};

interface Options {
  grants?: string[];
  env?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

function api({ grants = ALL, env = {}, context = {} }: Options = {}) {
  const { request } = createTestApp(BASE, welddataRoutes, {
    context: { tenantDb: db, permissions: permissions(...grants), ...context },
    env: { LEMLIST_API_KEY: 'lemlist-key', WORKSPACE_CACHE: kv, WELDDATA_ENRICH: enrich, ...env } as never,
  });
  const send = (method: string, path: string, body?: unknown) =>
    request(`${BASE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    get: (path: string) => request(`${BASE}${path}`),
    post: (path: string, body?: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    remove: (path: string) => send('DELETE', path),
  };
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

async function createList(name: string, kind?: 'person' | 'company'): Promise<string> {
  const res = await api().post('/lists', { name, ...(kind ? { kind } : {}) });
  expect(res.status).toBe(201);
  return (await json<{ data: { id: string } }>(res)).data.id;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', lemlist);
  db = (await createPgliteDb()).db;
  // Converting into CRM owns the new rows by the acting user, which CRM checks
  // against workspace_members.
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_user_test_default',
    userId: 'user_test_default',
    name: 'Test User',
    role: 'MEMBER',
  } as typeof schema.workspaceMembers.$inferInsert);
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  enrich.create.mockClear();
});

// ── the lead database ────────────────────────────────────────────────────────

describe('the Lemlist lead database', () => {
  it('answers the filter catalog per database, cached', async () => {
    const from = lemlist.mock.calls.length;
    const res = await api().get('/filters');
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { people: Array<{ filterId: string; type: string }>; companies: Array<{ filterId: string }> } }>(res);
    expect(data.people.map((f) => [f.filterId, f.type])).toEqual([
      ['jobTitle', 'text'],
      ['country', 'select'],
      ['hasEmail', 'boolean'],
      ['tech', 'select'],
    ]);
    expect(data.companies.map((f) => f.filterId)).toEqual(['country', 'headcount', 'hasEmail', 'tech']);
    const callsAfterFirst = lemlistCallsSince(lemlist, from);
    expect((await api().get('/filters')).status).toBe(200);
    expect(lemlistCallsSince(lemlist, from)).toBe(callsAfterFirst);
  });

  it('searches people, folding the keyword into its filter, and caches the page', async () => {
    const body = {
      filters: [{ filterId: 'keyword', values: ['cto'] }, { filterId: 'country', values: ['UK', 3] }],
      keyword: '  engines ',
      page: 2,
      size: 10,
    };
    const res = await api().post('/search/people', body);
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { rows: Array<Record<string, unknown>>; total: number; hasMore: boolean; page: number } }>(res);
    expect(data).toMatchObject({ total: 42, hasMore: false, page: 2, size: 10 });
    expect(data.rows[0]).toMatchObject({
      id: 'lp_ada',
      kind: 'person',
      name: 'Ada Lovelace',
      title: 'CTO',
      companyName: 'Analytical Engines',
      domain: 'engines.test',
      companySize: '11-50',
      avatarUrl: 'https://cdn.test/engines.png',
    });
    expect(data.rows[1]).toMatchObject({ id: 'lp_grace', name: 'Grace Hopper', title: 'Rear Admiral', companySize: '5000', location: 'Virginia' });
    expect(data.rows[2]).toMatchObject({ id: '4711', name: 'Anon', email: 'anon@example.test' });

    const from = lemlist.mock.calls.length;
    // The same search with the filters in another order is the same page.
    const again = await api().post('/search/people', { ...body, filters: [...body.filters].reverse() });
    expect(again.status).toBe(200);
    expect(lemlistCallsSince(lemlist, from)).toBe(0);
  });

  it('searches companies', async () => {
    const res = await api().post('/search/companies', { filters: [{ filterId: 'headcount', values: ['10|500'] }] });
    const { data } = await json<{ data: { rows: Array<Record<string, unknown>>; total: number; hasMore: boolean } }>(res);
    expect(data).toMatchObject({ total: 2, hasMore: false });
    expect(data.rows.map((r) => [r.id, r.name, r.domain, r.industry, r.companySize])).toEqual([
      ['lc_acme', 'Acme', 'acme.test', 'Anvils', '120'],
      ['lc_globex', 'Globex', 'globex.test', 'Energy', null],
    ]);
  });

  it('leaves out leads already saved in the lists named', async () => {
    const listId = await createList('Exclusions');
    await api().post(`/lists/${listId}/leads`, { leads: [{ kind: 'person', lemlistId: 'lp_ada', name: 'Ada' }] });
    const res = await api().post('/search/people', { filters: [{ filterId: 'jobTitle', values: ['x'] }], excludeListIds: [listId, ''] });
    const { data } = await json<{ data: { rows: Array<{ id: string }>; total: number } }>(res);
    expect(data.rows.map((r) => r.id)).toEqual(['lp_grace', '4711']);
    expect(data.total).toBe(41);
  });

  it('answers the provider’s refusals', async () => {
    const cases: Array<[string, number, string]> = [
      ['boom', 500, 'Lead database request failed'],
      ['unauthorized', 500, 'Lead database rejected the request (check API key)'],
      ['busy', 400, 'Lead database rate limit reached, please retry shortly'],
    ];
    for (const [value, status, message] of cases) {
      const res = await api().post('/search/companies', { filters: [{ filterId: 'tech', values: [value] }] });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
    }
    const unconfigured = await api({ env: { LEMLIST_API_KEY: undefined } }).post('/search/people', {});
    expect(unconfigured.status).toBe(500);
    expect(((await unconfigured.json()) as { error: { message: string } }).error.message).toBe('Lead database is not configured');
  }, 30_000);

  it('validates searches and needs prospects:read', async () => {
    expect((await api().post('/search/people', { page: 0 })).status).toBe(400);
    expect((await api().post('/search/people', { size: 101 })).status).toBe(400);
    expect((await api().post('/search/people', { filters: [{ values: [] }] })).status).toBe(400);
    expect((await api({ grants: ['prospects:create'] }).post('/search/people', {})).status).toBe(403);
    expect((await api({ grants: ['prospects:create'] }).get('/filters')).status).toBe(403);
  });
});

// ── lists and saved leads ────────────────────────────────────────────────────

describe('lists', () => {
  it('creates, reads, renames and deletes a list', async () => {
    const res = await api().post('/lists', { name: 'Prospects', description: 'Q4' });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: Record<string, unknown> & { id: string } }>(res);
    expect(data).toMatchObject({ name: 'Prospects', kind: 'person', color: 'bg-blue-500', icon: 'Database', createdBy: 'user_test_default' });

    const read = await json<{ data: Record<string, unknown> }>(await api().get(`/lists/${data.id}`));
    expect(read.data).toMatchObject({ leadCount: 0 });
    const renamed = await api().patch(`/lists/${data.id}`, { name: 'Renamed', color: 'bg-red-500' });
    expect((await json<{ data: Record<string, unknown> }>(renamed)).data).toMatchObject({ name: 'Renamed', color: 'bg-red-500' });

    expect((await api().remove(`/lists/${data.id}`)).status).toBe(204);
    expect((await api().get(`/lists/${data.id}`)).status).toBe(404);
    expect((await api().patch(`/lists/${data.id}`, { name: 'x' })).status).toBe(404);
    expect((await api().remove(`/lists/${data.id}`)).status).toBe(404);
  });

  it('lists with counts, a search and pages', async () => {
    const a = await createList('Alpha leads');
    await createList('Beta leads', 'company');
    await api().post(`/lists/${a}/leads`, { leads: [{ kind: 'person', lemlistId: 'x1' }, { kind: 'person', lemlistId: 'x2' }] });
    const all = await json<{ data: Array<{ id: string; leadCount: number }>; pagination: { totalCount: number } }>(
      await api().get('/lists?search=LEADS'),
    );
    expect(all.data.map((l) => l.id)).toContain(a);
    expect(all.data.find((l) => l.id === a)?.leadCount).toBe(2);
    expect(all.pagination.totalCount).toBe(2);
    const first = await json<{ data: unknown[]; pagination: { hasMore: boolean; cursor: string | null } }>(await api().get('/lists?limit=1'));
    expect(first.pagination.hasMore).toBe(true);
    const next = await api().get(`/lists?limit=1&cursor=${first.pagination.cursor}`);
    expect(next.status).toBe(200);
    expect((await api().get('/lists?limit=0')).status).toBe(400);
    expect((await api().get('/lists?cursor=wdlist_missing')).status).toBe(200);
  });

  it('validates lists and needs each permission', async () => {
    expect((await api().post('/lists', {})).status).toBe(400);
    expect((await api().post('/lists', { name: 'x', kind: 'robot' })).status).toBe(400);
    expect((await api().patch('/lists/wdlist_x', { name: '' })).status).toBe(400);
    expect((await api({ grants: ['prospects:read'] }).post('/lists', { name: 'x' })).status).toBe(403);
    expect((await api({ grants: ['prospects:read'] }).patch('/lists/x', { name: 'x' })).status).toBe(403);
    expect((await api({ grants: ['prospects:read'] }).remove('/lists/x')).status).toBe(403);
    expect((await api({ grants: ['prospects:create'] }).get('/lists')).status).toBe(403);
    expect((await api({ grants: ['prospects:create'] }).get('/lists/x')).status).toBe(403);
  });
});

describe('saved leads', () => {
  let listId: string;

  beforeAll(async () => {
    listId = await createList('Saved');
  });

  it('saves the leads of the list’s kind, once', async () => {
    const res = await api().post(`/lists/${listId}/leads`, {
      leads: [
        { kind: 'person', lemlistId: 'sl_1', name: 'Sam Saved', email: 'sam@saved.test', companyName: 'Saved Co', data: { source: 'test' } },
        { kind: 'person', lemlistId: 'sl_2', name: 'Pat Pending', title: 'CEO' },
        { kind: 'company', lemlistId: 'sl_c', name: 'Wrong kind' },
      ],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { added: 2, skipped: 1 } });
    const again = await api().post(`/lists/${listId}/leads`, { leads: [{ kind: 'person', lemlistId: 'sl_1' }] });
    expect(await again.json()).toEqual({ data: { added: 0, skipped: 1 } });
    const wrong = await api().post(`/lists/${listId}/leads`, { leads: [{ kind: 'company' }] });
    expect(await wrong.json()).toEqual({ data: { added: 0, skipped: 1 } });
  });

  it('lists, filters and pages the saved leads', async () => {
    const all = await json<{ data: Array<{ id: string; name: string }>; pagination: { totalCount: number } }>(
      await api().get(`/lists/${listId}/leads`),
    );
    expect(all.data.map((l) => l.name).sort()).toEqual(['Pat Pending', 'Sam Saved']);
    const searched = await json<{ data: Array<{ name: string }> }>(await api().get(`/lists/${listId}/leads?search=SAVED.TEST&kind=person&convertedStatus=pending`));
    expect(searched.data.map((l) => l.name)).toEqual(['Sam Saved']);
    const first = await json<{ pagination: { cursor: string | null } }>(await api().get(`/lists/${listId}/leads?limit=1`));
    expect((await api().get(`/lists/${listId}/leads?limit=1&cursor=${first.pagination.cursor}`)).status).toBe(200);
    expect((await api().get('/lists/wdlist_missing/leads')).status).toBe(404);
    expect((await api().get(`/lists/${listId}/leads?kind=robot`)).status).toBe(400);
  });

  it('removes a saved lead', async () => {
    const res = await api().post(`/lists/${listId}/leads`, { leads: [{ kind: 'person', lemlistId: 'sl_gone' }] });
    expect(res.status).toBe(201);
    const [lead] = await db.select().from(schema.welddataLeads).where(eq(schema.welddataLeads.lemlistId, 'sl_gone'));
    expect((await api().remove(`/leads/${lead!.id}`)).status).toBe(204);
    expect((await api().remove(`/leads/${lead!.id}`)).status).toBe(404);
  });

  it('refuses bad leads and missing lists', async () => {
    expect((await api().post(`/lists/${listId}/leads`, { leads: [] })).status).toBe(400);
    expect((await api().post(`/lists/${listId}/leads`, { leads: [{ kind: 'robot' }] })).status).toBe(400);
    expect((await api().post('/lists/wdlist_missing/leads', { leads: [{ kind: 'person' }] })).status).toBe(404);
    expect((await api({ grants: ['prospects:read'] }).remove('/leads/x')).status).toBe(403);
  });
});

// ── conversion into CRM ──────────────────────────────────────────────────────

describe('converting leads into CRM', () => {
  let listId: string;
  let companyListId: string;

  async function leadId(lemlistId: string): Promise<string> {
    const [lead] = await db.select().from(schema.welddataLeads).where(eq(schema.welddataLeads.lemlistId, lemlistId));
    return lead!.id;
  }

  beforeAll(async () => {
    listId = await createList('Convert');
    companyListId = await createList('Convert companies', 'company');
    await api().post(`/lists/${listId}/leads`, {
      leads: [
        { kind: 'person', lemlistId: 'cv_1', name: 'Linus  Torvalds', email: 'linus@kernel.test', title: 'Maintainer', companyName: 'Kernel Org', domain: 'kernel.test', linkedinUrl: 'https://linkedin.test/in/linus' },
        { kind: 'person', lemlistId: 'cv_2', name: 'Solo', companyName: 'kernel org' },
        { kind: 'person', lemlistId: 'cv_3', name: 'Dup Email', email: 'linus@kernel.test' },
      ],
    });
    await api().post(`/lists/${companyListId}/leads`, { leads: [{ kind: 'company', lemlistId: 'cv_c', companyName: 'Initech', domain: 'initech.test', industry: 'Software' }] });
  });

  it('converts a person, creating their company once', async () => {
    const id = await leadId('cv_1');
    const res = await api().post(`/leads/${id}/convert`, {});
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { leadId: string; personId: string; companyId: string } }>(res);
    expect(data.leadId).toBe(id);
    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, data.personId));
    expect(person).toMatchObject({ firstName: 'Linus', lastName: 'Torvalds', email: 'linus@kernel.test', isLead: true, source: 'welddata/lemlist' });
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, data.companyId));
    expect(company).toMatchObject({ name: 'Kernel Org', website: 'kernel.test', isLead: true });

    // The company is found by name, case-insensitively.
    const solo = await json<{ data: { companyId: string } }>(await api().post(`/leads/${await leadId('cv_2')}/convert`, {}));
    expect(solo.data.companyId).toBe(data.companyId);
    // Converting again changes nothing.
    expect(await json(await api().post(`/leads/${id}/convert`, {}))).toEqual({ data });
  });

  it('converts a company lead, and a person without a company', async () => {
    const company = await json<{ data: { personId: string | null; companyId: string } }>(
      await api().post(`/leads/${await leadId('cv_c')}/convert`, { createCompany: false }),
    );
    expect(company.data.personId).toBeNull();
    expect(company.data.companyId).toMatch(/^comp/);
  });

  it('fails a conversion CRM refuses, and refuses unknown leads', async () => {
    const dup = await api().post(`/leads/${await leadId('cv_3')}/convert`, {});
    expect(dup.status).toBe(500);
    expect(await dup.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to convert lead' } });
    expect((await api().post('/leads/wdlead_missing/convert', {})).status).toBe(404);
    expect((await api().post('/leads/x/convert', { createCompany: 'yes' })).status).toBe(400);
    expect((await api({ grants: ['prospects:read'] }).post('/leads/x/convert', {})).status).toBe(403);
  });

  it('converts search rows straight into CRM', async () => {
    const res = await api().post('/convert', {
      leads: [
        { kind: 'person', name: 'Margaret Hamilton', companyName: 'Apollo' },
        { kind: 'person', name: 'Second Apollo', companyName: 'Apollo' },
        { kind: 'company', name: 'Wayne Enterprises' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { converted: 3, people: 2, companies: 2 } });
    const failed = await api().post('/convert', { leads: [{ kind: 'company' }] });
    expect(failed.status).toBe(500);
    expect((await api().post('/convert', { leads: [] })).status).toBe(400);
  });

  it('converts onto a CRM list', async () => {
    const now = new Date();
    await db.insert(schema.lists).values([
      { id: 'list_people', name: 'Hot people', kind: 'person', createdAt: now, updatedAt: now },
      { id: 'list_companies', name: 'Hot companies', kind: 'company', createdAt: now, updatedAt: now },
    ] as (typeof schema.lists.$inferInsert)[]);
    const people = await api().post('/convert-to-list', {
      listId: 'list_people',
      leadIds: [await leadId('cv_1'), 'wdlead_missing'],
      leads: [{ kind: 'person', name: 'Inline Person' }],
    });
    expect(people.status).toBe(200);
    expect(await people.json()).toEqual({ data: { converted: 2, added: 2 } });
    const companies = await api().post('/convert-to-list', {
      listId: 'list_companies',
      leads: [{ kind: 'company', name: 'Kernel Org' }, { kind: 'company', name: 'kernel org' }],
    });
    expect(await companies.json()).toEqual({ data: { converted: 2, added: 1 } });
    const members = await db.select().from(schema.listMembers).where(eq(schema.listMembers.listId, 'list_people'));
    expect(members).toHaveLength(2);

    expect((await api().post('/convert-to-list', { listId: 'list_missing', leadIds: ['x'] })).status).toBe(404);
    const empty = await api().post('/convert-to-list', { listId: 'list_people', leads: [], leadIds: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { issues: Array<{ message: string }> } }).error.issues[0]?.message).toBe(
      'Provide at least one lead',
    );
    expect((await api({ grants: ['prospects:read'] }).post('/convert-to-list', { listId: 'x', leadIds: ['y'] })).status).toBe(403);
  });
});

// ── enrichment columns, cells and runs ───────────────────────────────────────

describe('enrichment columns', () => {
  let listId: string;
  let leadIds: string[];

  beforeAll(async () => {
    listId = await createList('Enrich');
    await api().post(`/lists/${listId}/leads`, {
      leads: [
        { kind: 'person', lemlistId: 'en_1', name: 'Enid One', domain: 'one.test' },
        { kind: 'person', lemlistId: 'en_2', name: 'Enid Two', domain: 'two.test' },
      ],
    });
    const rows = await db.select().from(schema.welddataLeads).where(eq(schema.welddataLeads.listId, listId));
    leadIds = rows.map((r) => r.id).sort();
  });

  it('adds, lists, edits and deletes columns', async () => {
    const created = await api().post(`/lists/${listId}/columns`, { name: 'Email', config: { type: 'email_finder' } });
    expect(created.status).toBe(201);
    const column = (await json<{ data: Record<string, unknown> & { id: string } }>(created)).data;
    expect(column).toMatchObject({ type: 'email_finder', sortOrder: 0, config: { type: 'email_finder', provider: 'findymail' }, createdBy: 'user_test_default' });
    const second = (await json<{ data: { id: string; sortOrder: number } }>(
      await api().post(`/lists/${listId}/columns`, { name: 'Summary', config: { type: 'ai', prompt: 'Summarise {{name}}' } }),
    )).data;
    expect(second.sortOrder).toBe(1);
    const columns = await json<{ data: Array<{ id: string }> }>(await api().get(`/lists/${listId}/columns`));
    expect(columns.data.map((c) => c.id)).toEqual([column.id, second.id]);

    const edited = await api().patch(`/columns/${second.id}`, { name: 'Phone', sortOrder: 5, config: { type: 'phone_finder', webSearchFallback: true } });
    expect((await json<{ data: unknown }>(edited)).data).toMatchObject({ name: 'Phone', type: 'phone_finder', sortOrder: 5, config: { type: 'phone_finder', source: 'website', webSearchFallback: true } });

    await db.insert(schema.welddataCells).values({ id: 'wdcell_del', columnId: second.id, leadId: leadIds[0]!, status: 'done', value: 'x' });
    expect((await api().remove(`/columns/${second.id}`)).status).toBe(204);
    expect(await db.select().from(schema.welddataCells).where(eq(schema.welddataCells.id, 'wdcell_del'))).toHaveLength(0);
    expect((await api().remove(`/columns/${second.id}`)).status).toBe(404);
    expect((await api().patch(`/columns/${second.id}`, { name: 'x' })).status).toBe(404);
  });

  it('validates columns', async () => {
    expect((await api().post(`/lists/${listId}/columns`, { name: 'x', config: { type: 'magic' } })).status).toBe(400);
    expect((await api().post(`/lists/${listId}/columns`, { name: 'x', config: { type: 'ai' } })).status).toBe(400);
    expect((await api().post(`/lists/${listId}/columns`, { name: '', config: { type: 'email_finder', provider: 'x' } })).status).toBe(400);
    expect((await api().patch('/columns/wdcol_x', { sortOrder: 1.5 })).status).toBe(400);
    expect((await api().post('/lists/wdlist_missing/columns', { name: 'x', config: { type: 'email_finder' } })).status).toBe(404);
    expect((await api({ grants: ['prospects:read'] }).post(`/lists/${listId}/columns`, { name: 'x', config: { type: 'email_finder' } })).status).toBe(403);
    expect((await api({ grants: ['prospects:read'] }).remove('/columns/x')).status).toBe(403);
  });

  it('lists cells, timing out the ones stuck running', async () => {
    const column = (await json<{ data: { id: string } }>(await api().post(`/lists/${listId}/columns`, { name: 'Cells', config: { type: 'email_finder' } }))).data;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(schema.welddataCells).values([
      { id: 'wdcell_stuck', columnId: column.id, leadId: leadIds[0]!, status: 'running', createdAt: old, updatedAt: old },
      { id: 'wdcell_live', columnId: column.id, leadId: leadIds[1]!, status: 'running' },
    ]);
    const res = await api().get(`/lists/${listId}/cells`);
    expect(res.status).toBe(200);
    const { data } = await json<{ data: Array<{ id: string; status: string; error: string | null }> }>(res);
    expect(data.find((c) => c.id === 'wdcell_stuck')).toMatchObject({ status: 'error', error: 'Timed out — please re-run.' });
    expect(data.find((c) => c.id === 'wdcell_live')).toMatchObject({ status: 'running' });
    expect(await json(await api().get('/lists/wdlist_missing/cells'))).toEqual({ data: [] });
  });

  it('queues a column run on the Workflow', async () => {
    const column = (await json<{ data: { id: string } }>(await api().post(`/lists/${listId}/columns`, { name: 'Run', config: { type: 'phone_finder' } }))).data;
    await db.insert(schema.welddataCells).values({ id: 'wdcell_done', columnId: column.id, leadId: leadIds[0]!, status: 'done', value: '+31 20 1234567' });

    const res = await api().post(`/lists/${listId}/columns/${column.id}/run`, { onlyMissing: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { queued: 1 } });
    expect(enrich.create).toHaveBeenCalledWith({
      params: { workspaceId: 'org_test_default', userId: 'user_test_default', listId, columnId: column.id, leadIds: [leadIds[1]] },
    });
    const [pending] = await db
      .select()
      .from(schema.welddataCells)
      .where(and(eq(schema.welddataCells.columnId, column.id), eq(schema.welddataCells.leadId, leadIds[1]!)));
    expect(pending).toMatchObject({ status: 'pending', error: null });

    // The lead with a finished cell is skipped when only missing ones are asked for.
    const none = await api().post(`/lists/${listId}/columns/${column.id}/run`, { leadIds: [leadIds[0]], onlyMissing: true });
    expect(await none.json()).toEqual({ data: { queued: 0 } });
    const all = await api().post(`/lists/${listId}/columns/${column.id}/run`, { leadIds });
    expect(await all.json()).toEqual({ data: { queued: 2 } });

    const cell = await api().post('/cells/run', { columnId: column.id, leadId: leadIds[0] });
    expect(await cell.json()).toEqual({ data: { queued: 1 } });
  });

  it('refuses runs it can’t queue', async () => {
    const column = (await json<{ data: { id: string } }>(await api().post(`/lists/${listId}/columns`, { name: 'Refuse', config: { type: 'email_finder' } }))).data;
    expect((await api({ context: { orgId: null } }).post(`/lists/${listId}/columns/${column.id}/run`, {})).status).toBe(400);
    expect((await api().post(`/lists/wdlist_other/columns/${column.id}/run`, {})).status).toBe(404);
    expect((await api().post(`/lists/${listId}/columns/wdcol_missing/run`, {})).status).toBe(404);
    const unbound = await api({ env: { WELDDATA_ENRICH: undefined } }).post(`/lists/${listId}/columns/${column.id}/run`, {});
    expect(unbound.status).toBe(500);
    expect(await unbound.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Enrichment is not configured' } });
    expect((await api().post(`/lists/${listId}/columns/${column.id}/run`, { leadIds: 'x' })).status).toBe(400);

    expect((await api({ context: { orgId: null } }).post('/cells/run', { columnId: column.id, leadId: 'x' })).status).toBe(400);
    expect((await api().post('/cells/run', { columnId: 'wdcol_missing', leadId: 'x' })).status).toBe(404);
    expect((await api({ env: { WELDDATA_ENRICH: undefined } }).post('/cells/run', { columnId: column.id, leadId: 'x' })).status).toBe(500);
    expect((await api().post('/cells/run', { columnId: column.id })).status).toBe(400);
    expect((await api({ grants: ['prospects:read'] }).post('/cells/run', { columnId: column.id, leadId: 'x' })).status).toBe(403);
    expect(enrich.create).not.toHaveBeenCalled();
  });
});

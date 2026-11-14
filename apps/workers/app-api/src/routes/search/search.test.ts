/**
 * POST /api/search against pglite: every record type matched and scored,
 * the type filter, query understanding (identifiers, the en/nl lexicon, and
 * the model tier: the mock model's parse, cached, or falling back without
 * AI), spreadsheets narrowed by WeldDrive sharing, product links per member
 * app, permissions, and the schema's refusals. POST /api/search/reindex: one
 * backfill page embedded through the mock model, the cursor, and its
 * refusals.
 *
 * The model is the mock model of `@weldsuite/ai/testing`, answered by
 * prompt, so the Rust backend runs the same tests in conformance mode.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMockModel, type MockChatRequest, type MockChatReply } from '@weldsuite/ai/testing';
import { searchRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

const ANN = 'user_ann';
const BOB = 'user_bob';

interface CallOptions {
  userId?: string;
  keys?: string[];
  env?: Record<string, unknown>;
}

function post(path: string, body: unknown, { userId = ANN, keys = ['*'], env }: CallOptions = {}) {
  const { request } = createTestApp('/api/search', searchRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
    ...(env ? { env } : {}),
  });
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function search(body: unknown, options: CallOptions = {}) {
  return post('/api/search', body, options);
}

/** The mock model, its parse answered by the query in the prompt. */
function stubModel(parses: Record<string, MockChatReply> = {}) {
  const model = createMockModel({
    chat: (request: MockChatRequest) => {
      const prompt = request.messages.map((message) => message.text).join('\n');
      const query = /Query: "([^"]*)"/.exec(prompt)?.[1] ?? '';
      // A 400: refused at once, never retried.
      return parses[query] ?? { status: 400, message: 'no answer for this query' };
    },
  });
  vi.stubGlobal('fetch', model.fetch);
  return model;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Group {
  type: string;
  items: { id: string; title: string; subtitle: string | null; url: string; score: number | null }[];
  hasMore: boolean;
}

interface SearchBody {
  data: Group[];
  permittedTypes: string[];
  understanding: { source: string; entityTypes: string[]; lexicalTerm: string };
}

async function body(res: Response): Promise<SearchBody> {
  expect(res.status).toBe(200);
  return (await res.json()) as SearchBody;
}

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const insert = (table: unknown, values: Record<string, unknown>) =>
    db.insert(table as typeof schema.files).values(values as never);

  await insert(schema.workspaceMembers, {
    id: 'wm_ann', userId: ANN, email: 'ann@test.dev', name: 'Ann', role: 'MEMBER', status: 'ACTIVE',
  });
  await insert(schema.workspaceMembers, {
    id: 'wm_bob', userId: BOB, email: 'bob@test.dev', name: 'Bob', role: 'MEMBER', status: 'ACTIVE',
  });
  await insert(schema.people, {
    id: 'per_acme', firstName: 'Acme', lastName: 'Person', fullName: 'Acme Person', displayName: 'Acme Person',
    email: 'contact@acme.test', title: 'Buyer', updatedAt: at(1),
  });
  await insert(schema.people, {
    id: 'per_mail', firstName: 'Mail', lastName: null, fullName: null, displayName: 'Mail',
    email: 'acme', updatedAt: at(2),
  });
  await insert(schema.companies, {
    id: 'com_acme', name: 'Acme', displayName: 'Acme', tradingName: 'Acme Trading', email: 'hi@acme.test',
    updatedAt: at(3),
  });
  await insert(schema.crmLeads, {
    id: 'lea_acme', firstName: 'Lena', lastName: 'Lead', fullName: 'Lena Lead', companyName: 'Acme Corp',
    email: 'lena@acme.test', updatedAt: at(4),
  });
  await insert(schema.crmOpportunities, {
    id: 'opp_acme', name: 'Acme renewal', customerId: 'com_acme', customerName: 'Acme', ownerId: ANN, updatedAt: at(5),
  });
  await insert(schema.helpdeskTickets, {
    id: 'tkt_acme', ticketNumber: 'T-100', subject: 'Acme pump broken', customerName: 'Acme',
    customerEmail: 'ops@acme.test', updatedAt: at(6),
  });
  await insert(schema.helpdeskArticles, {
    id: 'art_acme', title: 'Setting up Acme', slug: 'acme-setup', content: 'x', authorId: ANN,
    excerpt: 'How to set up Acme', updatedAt: at(7),
  });
  await insert(schema.knowledgeSpaces, { id: 'ksp_open', name: 'Handbook', kind: 'team', visibility: 'open' });
  await insert(schema.knowledgeSpaces, { id: 'ksp_closed', name: 'Board', kind: 'team', visibility: 'closed' });
  await insert(schema.knowledgePages, {
    id: 'kpg_acme', spaceId: 'ksp_open', title: 'Acme onboarding', contentText: 'Welcome', updatedAt: at(8),
  });
  await insert(schema.knowledgePages, {
    id: 'kpg_hidden', spaceId: 'ksp_closed', title: 'Acme board notes', updatedAt: at(9),
  });
  await insert(schema.products, {
    id: 'prd_acme', name: 'Acme widget', slug: 'acme-widget', sku: 'ACME-1', updatedAt: at(10),
  });
  await insert(schema.orders, {
    id: 'ord_acme', orderNumber: 'SO-1', customerName: 'Acme', customerEmail: 'buy@acme.test',
    total: '10.00', updatedAt: at(11),
  });
  await insert(schema.invoices, {
    id: 'inv_acme', entityId: 'ent_1', contactId: 'con_1', invoiceNumber: 'INV-2026-0001',
    contactName: 'Acme Corp', issueDate: at(12), dueDate: at(12), updatedAt: at(12),
  });
  await insert(schema.bills, {
    id: 'bil_acme', entityId: 'ent_1', contactId: 'con_1', billNumber: 'B-1', contactName: 'Acme Supplies',
    issueDate: at(13), dueDate: at(13), updatedAt: at(13),
  });
  await insert(schema.projects, {
    id: 'prj_acme', name: 'Acme launch', code: 'ACM', createdAt: at(14), updatedAt: at(14),
  });
  await insert(schema.tasks, { id: 'tsk_7', title: 'Call Acme', key: 'ACM-7', number: 7, updatedAt: at(15) });
  await insert(schema.tasks, { id: 'tsk_8', title: 'Unrelated', number: 8, updatedAt: at(16) });
  await insert(schema.hostDomains, {
    id: 'dom_acme', name: 'acme', tld: 'test', fullDomain: 'acme.test', registrar: 'cloudflare',
    status: 'active', updatedAt: at(17),
  });
  await insert(schema.hostDomains, {
    id: 'dom_unpaid', name: 'acme-unpaid', tld: 'test', fullDomain: 'acme-unpaid.test',
    registrationStatus: 'pending_payment', updatedAt: at(18),
  });
  // Spreadsheets: Ann's open one, and a restricted one of Bob's.
  for (const [id, owner, access, name] of [
    ['fil_sheet_open', ANN, 'workspace_edit', 'Acme budget'],
    ['fil_sheet_private', BOB, 'restricted', 'Acme salaries'],
  ] as const) {
    await insert(schema.files, {
      id, fileName: name, mimeType: 'application/vnd.weldsheet', fileSize: 1, storagePath: `w/${id}`,
      uploadedById: owner, generalAccess: access, updatedAt: at(19),
    });
    await insert(schema.sheets, { id: `sht_${id}`, fileId: id, updatedAt: at(19) });
  }
  // Ann can open WeldStash but not WeldCommerce.
  await insert(schema.workspaceInstalledApps, { id: 'wia_commerce', appCode: 'weldcommerce', displayOrder: 1 });
  await insert(schema.workspaceInstalledApps, { id: 'wia_stash', appCode: 'weldstash', displayOrder: 2 });
  await insert(schema.userAppAssignments, { id: 'uaa_ann_stash', userId: ANN, appCode: 'weldstash' });
}, 60_000);

describe('POST /api/search', () => {
  it('matches every permitted type, in canonical order', async () => {
    const res = await body(await search({ q: 'acme' }));
    expect(res.understanding.source).toBe('lexical');
    expect(res.data.map((g) => g.type)).toEqual([
      'contact', 'customer', 'lead', 'opportunity', 'ticket', 'article', 'knowledge_page', 'product',
      'order', 'invoice', 'bill', 'project', 'task', 'merge_issue', 'merge_pull_request', 'sheet', 'board', 'domain',
    ]);
    const byType = new Map(res.data.map((g) => [g.type, g]));
    expect(byType.get('knowledge_page')?.items.map((i) => i.id)).toEqual(['kpg_acme']);
    expect(byType.get('domain')?.items.map((i) => i.id)).toEqual(['dom_acme']);
    expect(byType.get('sheet')?.items.map((i) => i.id)).toEqual(['sht_fil_sheet_open']);
    expect(byType.get('product')?.items[0]?.url).toBe('/weldstash/products?stack=product:prd_acme');
    expect(byType.get('contact')?.items.map((i) => i.id)).toEqual(['per_mail', 'per_acme']);
  });

  it('keeps to the requested types and limit', async () => {
    const res = await body(await search({ q: 'acme', types: ['contact', 'invoice'], limit: 1 }));
    expect(res.data.map((g) => g.type)).toEqual(['contact', 'invoice']);
    expect(res.data[0]?.hasMore).toBe(true);
  });

  it('structures natural-language queries', async () => {
    const lexicon = await body(await search({ q: 'Invoice from Acme Corp' }));
    expect(lexicon.understanding).toEqual({ source: 'lexicon', entityTypes: ['invoice'], lexicalTerm: 'Acme Corp' });
    expect(lexicon.data.map((g) => g.type)).toEqual(['invoice']);
    const fallback = await body(await search({ q: 'the broken acme pump report' }));
    expect(fallback.understanding.source).toBe('model_failed');
  });

  it('asks the model for what the lexicon cannot shape, and caches its parse', async () => {
    const model = stubModel({
      'the broken acme pump report': {
        json: { entityTypes: ['ticket'], searchTerm: 'acme pump', semanticQuery: 'broken acme pump' },
      },
    });
    const env = { ...model.env, WORKSPACE_CACHE: createMemoryKv() };
    const parsed = await body(await search({ q: 'the broken acme pump report' }, { env }));
    expect(parsed.understanding).toEqual({ source: 'model', entityTypes: ['ticket'], lexicalTerm: 'acme pump' });
    expect(parsed.data.map((g) => g.type)).toEqual(['ticket']);
    expect(parsed.data[0]?.items.map((i) => i.id)).toEqual(['tkt_acme']);
    const asked = model.calls.filter((call) => call.path === '/chat/completions');
    expect(asked.length).toBeGreaterThan(0);

    // The same query again, any spacing or case: the cached parse, no model.
    vi.unstubAllGlobals();
    const failing = stubModel();
    const cached = await body(await search({ q: '  The broken ACME pump report ' }, { env: { ...failing.env, WORKSPACE_CACHE: env.WORKSPACE_CACHE } }));
    expect(cached.understanding).toEqual({ source: 'model', entityTypes: ['ticket'], lexicalTerm: 'acme pump' });
    expect(failing.calls).toEqual([]);
  });

  it('falls back to the raw query when the model fails', async () => {
    const model = stubModel();
    const env = { ...model.env, WORKSPACE_CACHE: createMemoryKv() };
    const res = await body(await search({ q: 'every overdue thing for jansen' }, { env }));
    expect(res.understanding).toEqual({ source: 'model_failed', entityTypes: [], lexicalTerm: 'every overdue thing for jansen' });
  });

  it('finds a task by its number', async () => {
    for (const q of ['TASK-7', '#7', '7']) {
      const res = await body(await search({ q, types: ['task'] }));
      expect(res.data[0]?.items.map((i) => i.id)).toEqual(['tsk_7']);
    }
  });

  it('shows another member only the spreadsheets WeldDrive lets them open', async () => {
    const bob = await body(await search({ q: 'acme', types: ['sheet'] }, { userId: BOB }));
    expect(bob.data[0]?.items.map((i) => i.title).sort()).toEqual(['Acme budget', 'Acme salaries']);
    const none = await body(await search({ q: 'zzz', types: ['sheet'] }));
    expect(none.data[0]?.items).toEqual([]);
  });

  it('leaves out what the caller may not read', async () => {
    const res = await body(await search({ q: 'acme' }, { keys: ['contacts:read'] }));
    expect(res.permittedTypes).toEqual(['contact', 'customer']);
    expect(res.data.map((g) => g.type)).toEqual(['contact', 'customer']);
    const nothing = await body(await search({ q: 'acme' }, { keys: [] }));
    expect(nothing.data).toEqual([]);
  });

  it('refuses a body the schema rejects', async () => {
    expect((await search({ q: '   ' })).status).toBe(400);
    expect((await search({ q: 'acme', types: ['bogus'] })).status).toBe(400);
    expect((await search({ q: 'acme', limit: 50 })).status).toBe(400);
    expect((await search({})).status).toBe(400);
  });
});

describe('POST /api/search/reindex', () => {
  const ADMIN_KEYS = ['settings:general:update'];

  function reindex(body: unknown, env: Record<string, unknown>, keys = ADMIN_KEYS) {
    return post('/api/search/reindex', body, { keys, env });
  }

  it('embeds one page of the first indexed type and hands back the cursor', async () => {
    const model = stubModel();
    const res = await reindex({}, { ...model.env, WORKSPACE_CACHE: createMemoryKv() });
    expect(res.status).toBe(200);
    // Only the page in the open team space is indexed.
    expect(await res.json()).toEqual({
      data: { cursor: { entityType: 'article', afterId: null }, done: false, processed: 1, embedded: 1, skipped: 0 },
    });
    expect(model.calls.some((call) => call.path === '/embeddings')).toBe(true);
    const rows = await db
      .select({ entityId: schema.searchIndex.entityId, title: schema.searchIndex.title, url: schema.searchIndex.url })
      .from(schema.searchIndex)
      .where(eq(schema.searchIndex.entityType, 'knowledge_page'));
    expect(rows).toEqual([{ entityId: 'kpg_acme', title: 'Acme onboarding', url: expect.stringContaining('kpg_acme') }]);
  });

  it('moves on past a type without a loader', async () => {
    const model = stubModel();
    const res = await reindex(
      { cursor: { entityType: 'product', afterId: null } },
      { ...model.env, WORKSPACE_CACHE: createMemoryKv() },
    );
    expect(res.status).toBe(200);
    // No custom objects: the walk is over.
    expect(await res.json()).toEqual({ data: { cursor: null, done: true, processed: 0, embedded: 0, skipped: 0 } });
  });

  it('is 409 while another walk holds the lease, 503 without AI, 403 without the permission, 400 for a bad cursor', async () => {
    const model = stubModel();
    const held = createMemoryKv();
    await held.put('search-reindex-lock:org_test_default', new Date().toISOString());
    const busy = await reindex({}, { ...model.env, WORKSPACE_CACHE: held });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('REINDEX_IN_PROGRESS');

    const off = await reindex({}, { WORKSPACE_CACHE: createMemoryKv() });
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED');

    expect((await reindex({}, model.env, ['contacts:read'])).status).toBe(403);
    expect((await reindex({ cursor: { entityType: 'bogus', afterId: null } }, model.env)).status).toBe(400);
  });
});

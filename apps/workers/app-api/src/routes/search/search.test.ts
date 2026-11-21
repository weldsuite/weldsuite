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
}, 60_000);

describe('POST /api/search', () => {
  it('matches every permitted type, in canonical order', async () => {
    const res = await body(await search({ q: 'acme' }));
    expect(res.understanding.source).toBe('lexical');
    expect(res.data.map((g) => g.type)).toEqual([
      'contact', 'customer', 'lead', 'opportunity', 'ticket', 'conversation', 'article', 'knowledge_page',
      'product', 'order', 'warehouse', 'invoice', 'bill', 'project', 'task', 'merge_issue', 'merge_pull_request',
      'document', 'sheet', 'board', 'form', 'sign_envelope', 'drive_file', 'meeting', 'chat_channel', 'reach_campaign',
      'data_list', 'panel_project', 'workflow', 'agent', 'domain',
    ]);
    const byType = new Map(res.data.map((g) => [g.type, g]));
    expect(byType.get('knowledge_page')?.items.map((i) => i.id)).toEqual(['kpg_acme']);
    expect(byType.get('domain')?.items.map((i) => i.id)).toEqual(['dom_acme']);
    expect(byType.get('sheet')?.items.map((i) => i.id)).toEqual(['sht_fil_sheet_open']);
    expect(byType.get('product')?.items[0]?.url).toBe('/weldcommerce/products?open=prd_acme');
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

// The records of the other modules. Everything here is named "zeta", so the
// groups above (matched on "acme") stay as they are.
describe('POST /api/search · more record types', () => {
  /** What a plain member holds: every read key, none of the "see everything" ones. */
  const MEMBER = [
    'docs:read', 'forms:read', 'welddrive:files:read', 'conversations:read', 'weldmeet:meetings:read',
    'sign_envelopes:read', 'warehouses:read', 'weldconnect:workflows:read', 'weldagent:read',
    'reach_campaigns:read', 'weldchat:channels:read', 'prospects:read', 'panel_projects:read',
  ];
  const NEW_TYPES = [
    'document', 'form', 'drive_file', 'conversation', 'meeting', 'sign_envelope', 'warehouse', 'workflow',
    'agent', 'reach_campaign', 'chat_channel', 'data_list', 'panel_project',
  ];

  const insert = (table: unknown, values: Record<string, unknown> | Record<string, unknown>[]) =>
    db.insert(table as typeof schema.files).values(values as never);

  async function found(type: string, options: CallOptions = {}, q = 'zeta', limit = 20) {
    const res = await body(await search({ q, types: [type], limit }, { keys: MEMBER, ...options }));
    return res.data.flatMap((g) => g.items.map((i) => i.id)).sort();
  }

  async function drive(id: string, name: string, owner: string, access: string, extra: Record<string, unknown> = {}) {
    await insert(schema.files, {
      id, fileName: name, mimeType: 'application/octet-stream', fileSize: 1, storagePath: `w/${id}`,
      uploadedById: owner, generalAccess: access, updatedAt: at(30), ...extra,
    });
  }

  beforeAll(async () => {
    // WeldDocs: the open one, Bob's restricted one, a pre-WeldDocs row and a trashed one.
    for (const [file, doc, name, owner, access, snapshot, extra] of [
      ['fil_zdoc_open', 'doc_zopen', 'Zeta proposal', ANN, 'workspace_edit', 'k/1', {}],
      ['fil_zdoc_private', 'doc_zprivate', 'Zeta contract', BOB, 'restricted', 'k/2', {}],
      ['fil_zdoc_legacy', 'doc_zlegacy', 'Zeta legacy notes', ANN, 'workspace_edit', null, {}],
      ['fil_zdoc_trashed', 'doc_ztrashed', 'Zeta trashed doc', ANN, 'workspace_edit', 'k/3', { deletedAt: at(31) }],
    ] as const) {
      await drive(file, name, owner, access, extra);
      await insert(schema.docs, { id: doc, fileId: file, snapshotKey: snapshot, updatedAt: at(30) });
    }

    // WeldDrive files: the same four ways to be hidden, and the ones that are other types.
    await drive('fil_zfile_open', 'Zeta notes.pdf', ANN, 'workspace_edit');
    await drive('fil_zfile_private', 'Zeta payroll.xlsx', BOB, 'restricted');
    await drive('fil_zfile_trashed', 'Zeta old.pdf', ANN, 'workspace_edit', { deletedAt: at(31) });
    await drive('fil_zfile_module', 'Zeta attachment.pdf', ANN, 'workspace_edit', { entityType: 'project', entityId: 'prj_acme' });
    await drive('fil_zsheet', 'Zeta budget', ANN, 'workspace_edit');
    await insert(schema.sheets, { id: 'sht_zeta', fileId: 'fil_zsheet', updatedAt: at(30) });
    await drive('fil_zboard', 'Zeta retro', ANN, 'workspace_edit');
    await insert(schema.whiteboards, { id: 'brd_zeta', fileId: 'fil_zboard', createdAt: at(30), updatedAt: at(30) });

    // WeldForms: open to the workspace, Ann's restricted, Bob's restricted, Bob listed on one of Ann's.
    const form = (id: string, title: string, owner: string, access: string) => ({
      id, title, ownerUserId: owner, access, status: 'published', definition: {}, settings: {}, updatedAt: at(30),
    });
    await insert(schema.forms, [
      form('frm_zworkspace', 'Zeta feedback', ANN, 'workspace'),
      form('frm_zann', 'Zeta Ann only', ANN, 'restricted'),
      form('frm_zbob', 'Zeta Bob only', BOB, 'restricted'),
      form('frm_zshared', 'Zeta shared with Bob', ANN, 'restricted'),
    ]);
    await insert(schema.formAccess, { id: 'fac_zbob', formId: 'frm_zshared', userId: BOB, role: 'results' });

    // WeldDesk conversations: found by title, customer, e-mail and number.
    await insert(schema.deskConversations, [
      { id: 'dcv_ztitle', conversationNumber: 4201, title: 'Zeta pump is broken', name: 'Ops', email: 'ops@x.test', updatedAt: at(30) },
      { id: 'dcv_zname', conversationNumber: 4202, title: null, name: 'Zeta Corp', email: null, updatedAt: at(31) },
      { id: 'dcv_zmail', conversationNumber: 4203, title: null, name: null, email: 'help@zeta.test', updatedAt: at(32) },
      { id: 'dcv_other', conversationNumber: 4204, title: 'Something else', updatedAt: at(33) },
    ]);

    // WeldMeet: Ann organises one, Bob another, and one is deleted.
    await insert(schema.meetings, [
      { id: 'mtg_zann', title: 'Zeta planning', organizerId: ANN, status: 'scheduled', updatedAt: at(30) },
      { id: 'mtg_zbob', title: 'Zeta retro call', organizerId: BOB, status: 'scheduled', updatedAt: at(31) },
      { id: 'mtg_zgone', title: 'Zeta cancelled', organizerId: ANN, deletedAt: at(32), updatedAt: at(32) },
    ]);

    // WeldSign: Ann sends a draft and a sent request (to Bob), Bob sends one, and a template.
    await insert(schema.signEnvelopes, [
      { id: 'sgn_zdraft', title: 'Zeta draft NDA', senderUserId: ANN, status: 'draft', updatedAt: at(30) },
      { id: 'sgn_zsent', title: 'Zeta NDA', senderUserId: ANN, status: 'sent', updatedAt: at(31) },
      { id: 'sgn_zbob', title: 'Zeta Bob request', senderUserId: BOB, status: 'sent', updatedAt: at(32) },
      { id: 'sgn_ztemplate', title: 'Zeta template', kind: 'template', senderUserId: ANN, updatedAt: at(33) },
    ]);
    await insert(schema.signRecipients, [
      { id: 'sgr_zdraft', envelopeId: 'sgn_zdraft', email: 'bob@test.dev', name: 'Bob' },
      { id: 'sgr_zsent', envelopeId: 'sgn_zsent', email: 'bob@test.dev', name: 'Bob' },
    ]);

    await insert(schema.warehouses, [
      { id: 'whs_zmain', name: 'Zeta Rotterdam', code: 'ZR1', city: 'Rotterdam', updatedAt: at(30) },
      { id: 'whs_zgone', name: 'Zeta closed', deletedAt: at(31), updatedAt: at(31) },
    ]);

    await insert(schema.workflows, [
      { id: 'wfl_zonboard', name: 'Zeta onboarding', status: 'active', tags: ['hr'], updatedAt: at(30) },
      { id: 'wfl_zseq', name: 'Zeta sequence', tags: ['__type:sequence'], updatedAt: at(31) },
      { id: 'wfl_zgone', name: 'Zeta deleted', deletedAt: at(32), updatedAt: at(32) },
    ]);

    // WeldAgent: everyone's, Ann's private one, a members one Bob is listed on, Bob's own, a deleted one.
    const agent = (id: string, name: string, owner: string, visibility: string, extra = {}) => ({
      id, name, ownerId: owner, visibility, updatedAt: at(30), ...extra,
    });
    await insert(schema.weldagentAgents, [
      agent('agt_zworkspace', 'Zeta helper', ANN, 'workspace', { description: 'Answers Zeta questions' }),
      agent('agt_zprivate', 'Zeta Ann private', ANN, 'private'),
      agent('agt_zmembers', 'Zeta team agent', ANN, 'members'),
      agent('agt_zbob', 'Zeta Bob private', BOB, 'private'),
      agent('agt_zgone', 'Zeta deleted', ANN, 'workspace', { deletedAt: at(32) }),
    ]);
    await insert(schema.weldagentAgentMembers, { id: 'agm_zbob', agentId: 'agt_zmembers', userId: BOB });

    await insert(schema.reachCampaigns, [
      { id: 'rcmp_zfall', name: 'Zeta autumn', status: 'draft', updatedAt: at(30) },
      { id: 'rcmp_zgone', name: 'Zeta old', deletedAt: at(31), updatedAt: at(31) },
    ]);

    // WeldChat: public, a private one Ann is in, a DM and a record channel.
    const channel = (id: string, name: string, type: string, extra = {}) => ({
      id, name, slug: id, type, updatedAt: at(30), ...extra,
    });
    await insert(schema.chatChannels, [
      channel('chn_zpublic', 'zeta-general', 'public', { topic: 'All things Zeta' }),
      channel('chn_zprivate', 'zeta-private', 'private'),
      channel('chn_zdm', 'zeta-dm', 'dm'),
      channel('chn_zentity', 'zeta-record', 'entity', { entityType: 'company', entityId: 'com_acme' }),
      channel('chn_zgone', 'zeta-gone', 'public', { deletedAt: at(31) }),
    ]);
    await insert(schema.chatChannelMembers, [
      { id: 'ccm_zprivate', channelId: 'chn_zprivate', userId: ANN },
      { id: 'ccm_zdm', channelId: 'chn_zdm', userId: ANN },
      { id: 'ccm_zentity', channelId: 'chn_zentity', userId: ANN },
    ]);

    await insert(schema.welddataLists, [
      { id: 'wdl_zbenelux', name: 'Zeta Benelux', description: 'Prospects in the Benelux', updatedAt: at(30) },
      { id: 'wdl_zgone', name: 'Zeta deleted', deletedAt: at(31), updatedAt: at(31) },
    ]);

    await insert(schema.panelProjects, [
      { id: 'pnp_zsite', name: 'Zeta website', kind: 'website', status: 'active', token: 'wpk_zsite', settings: {}, createdByUserId: ANN, updatedAt: at(30) },
      { id: 'pnp_zgone', name: 'Zeta deleted', token: 'wpk_zgone', settings: {}, createdByUserId: ANN, deletedAt: at(31), updatedAt: at(31) },
    ]);
  }, 60_000);

  it('finds a record of every new type and says where it opens', async () => {
    const res = await body(await search({ q: 'zeta', types: NEW_TYPES, limit: 20 }, { keys: ['*'] }));
    expect(res.data.map((g) => g.type)).toEqual([
      'conversation', 'warehouse', 'document', 'form', 'sign_envelope', 'drive_file', 'meeting', 'chat_channel',
      'reach_campaign', 'data_list', 'panel_project', 'workflow', 'agent',
    ]);
    const first = (type: string) => res.data.find((g) => g.type === type)?.items[0];
    expect(first('document')).toMatchObject({ id: 'doc_zopen', title: 'Zeta proposal', subtitle: null, url: '/welddocs/doc_zopen' });
    expect(first('drive_file')).toMatchObject({ id: 'fil_zfile_open', title: 'Zeta notes.pdf', url: '/welddrive?file=fil_zfile_open' });
    expect(first('warehouse')).toMatchObject({
      id: 'whs_zmain', title: 'Zeta Rotterdam', subtitle: 'ZR1', url: '/weldstash/warehouses?stack=warehouse:whs_zmain',
    });
    expect(first('workflow')).toMatchObject({ id: 'wfl_zonboard', subtitle: 'active', url: '/weldconnect/workflows/wfl_zonboard' });
    expect(first('agent')).toMatchObject({ id: 'agt_zworkspace', subtitle: 'Answers Zeta questions', url: '/agents/agt_zworkspace' });
    expect(first('reach_campaign')).toMatchObject({ title: 'Zeta autumn', subtitle: 'draft', url: '/weldreach/campaigns/rcmp_zfall' });
    expect(first('chat_channel')).toMatchObject({ id: 'chn_zpublic', subtitle: 'All things Zeta', url: '/weldchat/chn_zpublic' });
    expect(first('data_list')).toMatchObject({ title: 'Zeta Benelux', subtitle: 'Prospects in the Benelux', url: '/welddata/lists/wdl_zbenelux' });
    expect(first('panel_project')).toMatchObject({ subtitle: 'website · active', url: '/weldpanel/projects/pnp_zsite' });
    expect(first('meeting')?.url).toMatch(/^\/weldmeet\/mtg_z/);
    expect(first('sign_envelope')?.url).toMatch(/^\/weldsign\/sgn_z/);
    expect(first('form')?.url).toMatch(/^\/weldforms\/frm_z/);
  });

  it('scores a title the same way for every type', async () => {
    const res = await body(await search({ q: 'Zeta Benelux', types: ['data_list'] }, { keys: ['*'] }));
    expect(res.data[0]?.items[0]?.score).toBe(1);
    const prefix = await body(await search({ q: 'zeta ben', types: ['data_list'] }, { keys: ['*'] }));
    expect(prefix.data[0]?.items[0]?.score).toBe(0.9);
    const inner = await body(await search({ q: 'benelux', types: ['data_list'] }, { keys: ['*'] }));
    expect(inner.data[0]?.items[0]?.score).toBe(0.6);
  });

  it('matches what is typed, not a pattern, and reports more rows', async () => {
    expect(await found('data_list', {}, 'zeta_benelux')).toEqual([]);
    expect(await found('data_list', {}, '%')).toEqual([]);
    const res = await body(await search({ q: 'zeta', types: ['warehouse', 'data_list'], limit: 1 }, { keys: MEMBER }));
    expect(res.data.map((g) => [g.type, g.items.length, g.hasMore])).toEqual([
      ['warehouse', 1, false],
      ['data_list', 1, false],
    ]);
    const forms = await body(await search({ q: 'zeta', types: ['form'], limit: 1 }, { keys: ['*'] }));
    expect(forms.data[0]).toMatchObject({ hasMore: true });
    expect(forms.data[0]?.items).toHaveLength(1);
  });

  it('leaves out deleted records and what is not the module\'s list', async () => {
    expect(await found('warehouse')).toEqual(['whs_zmain']);
    expect(await found('workflow')).toEqual(['wfl_zonboard']); // not the CRM sequence
    expect(await found('reach_campaign')).toEqual(['rcmp_zfall']);
    expect(await found('data_list')).toEqual(['wdl_zbenelux']);
    expect(await found('panel_project')).toEqual(['pnp_zsite']);
  });

  it('finds a conversation by title, customer, e-mail and number', async () => {
    expect(await found('conversation')).toEqual(['dcv_zmail', 'dcv_zname', 'dcv_ztitle']);
    expect(await found('conversation', {}, '#4203')).toEqual(['dcv_zmail']);
    expect(await found('conversation', {}, '4204')).toEqual(['dcv_other']);
    const named = await body(await search({ q: 'zeta corp', types: ['conversation'] }, { keys: MEMBER }));
    expect(named.data[0]?.items[0]).toMatchObject({ id: 'dcv_zname', title: 'Zeta Corp', subtitle: '#4202 · Zeta Corp', score: 1 });
    const titled = await body(await search({ q: 'pump', types: ['conversation'] }, { keys: MEMBER }));
    expect(titled.data[0]?.items[0]).toMatchObject({ title: 'Zeta pump is broken', subtitle: '#4201 · Ops' });
  });

  it('shows documents and files as far as WeldDrive lets the caller open them', async () => {
    expect(await found('document')).toEqual(['doc_zopen']); // not Bob's private, legacy or trashed
    expect(await found('document', { userId: BOB })).toEqual(['doc_zopen', 'doc_zprivate']);
    // Files: Drive uploads only, not the files behind documents, spreadsheets and boards.
    expect(await found('drive_file')).toEqual(['fil_zfile_open']);
    expect(await found('drive_file', { userId: BOB })).toEqual(['fil_zfile_open', 'fil_zfile_private']);
  });

  it('shows a form to the workspace, its owner and its access list, and to forms:manage', async () => {
    expect(await found('form')).toEqual(['frm_zann', 'frm_zshared', 'frm_zworkspace']);
    expect(await found('form', { userId: BOB })).toEqual(['frm_zbob', 'frm_zshared', 'frm_zworkspace']);
    expect(await found('form', { keys: [...MEMBER, 'forms:manage'] })).toEqual([
      'frm_zann', 'frm_zbob', 'frm_zshared', 'frm_zworkspace',
    ]);
  });

  it('shows a meeting to its organiser, and every meeting to meetings:scope:all', async () => {
    expect(await found('meeting')).toEqual(['mtg_zann']);
    expect(await found('meeting', { userId: BOB })).toEqual(['mtg_zbob']);
    expect(await found('meeting', { keys: [...MEMBER, 'weldmeet:meetings:scope:all'] })).toEqual(['mtg_zann', 'mtg_zbob']);
    expect(await found('meeting', { keys: [...MEMBER, 'meetings:scope:all'] })).toEqual(['mtg_zann', 'mtg_zbob']);
  });

  it('shows a signature request to its sender and to a recipient of a sent one', async () => {
    expect(await found('sign_envelope')).toEqual(['sgn_zdraft', 'sgn_zsent']); // not Bob's, not the template
    // Bob: his own, and Ann's sent request (not her draft: the recipient only sees it once sent).
    expect(await found('sign_envelope', { userId: BOB })).toEqual(['sgn_zbob', 'sgn_zsent']);
    expect(await found('sign_envelope', { keys: [...MEMBER, 'sign_envelopes:manage'] })).toEqual([
      'sgn_zbob', 'sgn_zdraft', 'sgn_zsent',
    ]);
  });

  it('shows public channels and joined private ones, never DMs or record channels', async () => {
    expect(await found('chat_channel')).toEqual(['chn_zprivate', 'chn_zpublic']);
    expect(await found('chat_channel', { userId: BOB })).toEqual(['chn_zpublic']);
    // Even with every permission: a DM or a record channel is not a channel here.
    expect(await found('chat_channel', { keys: ['*'] })).toEqual(['chn_zprivate', 'chn_zpublic']);
  });

  it('shows an agent per its visibility, and every agent to weldagent:manage', async () => {
    expect(await found('agent')).toEqual(['agt_zmembers', 'agt_zprivate', 'agt_zworkspace']);
    expect(await found('agent', { userId: BOB })).toEqual(['agt_zbob', 'agt_zmembers', 'agt_zworkspace']);
    expect(await found('agent', { keys: [...MEMBER, 'weldagent:manage'], userId: BOB })).toEqual([
      'agt_zbob', 'agt_zmembers', 'agt_zprivate', 'agt_zworkspace',
    ]);
  });

  it('leaves a type out when its permission is missing', async () => {
    const one = async (key: string) => (await body(await search({ q: 'zeta' }, { keys: [key] }))).permittedTypes;
    expect(await one('docs:read')).toEqual(['document']);
    expect(await one('forms:read')).toEqual(['form']);
    expect(await one('welddrive:files:read')).toEqual(['drive_file']);
    expect(await one('files:read')).toEqual(['drive_file']); // grants stored before the per-app keys
    expect(await one('weldflow:files:read')).toEqual([]); // WeldFlow's files are not WeldDrive's
    expect(await one('conversations:read')).toEqual(['conversation']);
    expect(await one('weldmeet:meetings:read')).toEqual(['meeting']);
    expect(await one('weldcalendar:meetings:read')).toEqual([]);
    expect(await one('sign_envelopes:read')).toEqual(['sign_envelope']);
    expect(await one('warehouses:read')).toEqual(['warehouse']);
    expect(await one('weldconnect:workflows:read')).toEqual(['workflow']);
    expect(await one('welddesk:workflows:read')).toEqual([]);
    expect(await one('weldagent:read')).toEqual(['agent']);
    expect(await one('reach_campaigns:read')).toEqual(['reach_campaign']);
    expect(await one('weldchat:channels:read')).toEqual(['chat_channel']);
    expect(await one('prospects:read')).toEqual(['data_list']);
    expect(await one('panel_projects:read')).toEqual(['panel_project']);
    const none = await body(await search({ q: 'zeta' }, { keys: ['contacts:read'] }));
    expect(none.permittedTypes).toEqual(['contact', 'customer']);
  });

  it('structures a query that names one of the new types', async () => {
    const res = await body(await search({ q: 'meeting zeta planning' }, { keys: MEMBER }));
    expect(res.understanding).toEqual({ source: 'lexicon', entityTypes: ['meeting'], lexicalTerm: 'zeta planning' });
    expect(res.data.map((g) => g.type)).toEqual(['meeting']);
    expect(res.data[0]?.items.map((i) => i.id)).toEqual(['mtg_zann']);
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

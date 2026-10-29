/**
 * POST /api/search against pglite: every record type matched and scored,
 * the type filter, query understanding (identifiers, the en/nl lexicon, and
 * the model tier falling back without a gateway), spreadsheets narrowed by
 * WeldDrive sharing, product links per member app, permissions, and the
 * schema's refusals.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

const ANN = 'user_ann';
const BOB = 'user_bob';

function search(body: unknown, { userId = ANN, keys = ['*'] }: { userId?: string; keys?: string[] } = {}) {
  const { request } = createTestApp('/api/search', searchRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
  return request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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
      'order', 'invoice', 'bill', 'project', 'task', 'sheet', 'domain',
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

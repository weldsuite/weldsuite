/**
 * The public help center (/public/helpcenter/*) on pglite: the tenant is
 * resolved from `?domain=` through the master `helpcenter_domain_registry`
 * (cached in the `WORKSPACE_CACHE` KV), and only published + public articles
 * are served. Every route, with its refusals.
 *
 * Public: the worker mounts these ahead of the Clerk guard, and the session
 * the harness adds is never read. Conformance-ready: the master database is
 * shared through `conformanceMasterDb`, the tenant database through
 * `conformanceTenantDb`, the KV namespace is a memory KV the harness shares.
 * GET /articles/:slug counts a view, so it carries the conformance write
 * header and runs as a write.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
}));

import { publicHelpcenterRoutes } from './index';

const BASE = '/public/helpcenter';
const DOMAIN = 'help.acme.test';
const q = `domain=${DOMAIN}`;
const articles = schema.helpdeskArticles;

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

function app() {
  return createTestApp(BASE, publicHelpcenterRoutes, {
    context: { tenantDb, masterDb: master, orgId: null, clerkOrgId: null },
    env: { WORKSPACE_CACHE: kv } as never,
  });
}

const get = (path: string, init?: RequestInit) => app().request(`${BASE}${path}`, init);
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function seedArticle(id: string, second: number, values: Partial<typeof articles.$inferInsert>) {
  await tenantDb.insert(articles).values({
    id,
    title: id,
    slug: id,
    content: `Content of ${id}`,
    authorId: 'user_author',
    status: 'published',
    visibility: 'public',
    createdAt: at(second),
    updatedAt: at(second),
    ...values,
  });
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = tenantDb;

  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_hc', clerkOrgId: 'org_hc', name: 'Acme', slug: 'acme-hc' },
    { id: 'ws_hc_noorg', clerkOrgId: null, name: 'No Org', slug: 'no-org-hc' },
  ]);
  await master.insert(masterSchema.helpcenterDomainRegistry).values([
    { id: 'hcd_acme', domain: DOMAIN, domainType: 'custom', workspaceId: 'ws_hc' },
    { id: 'hcd_old', domain: 'old.acme.test', domainType: 'custom', workspaceId: 'ws_hc', isActive: 0 },
    { id: 'hcd_noorg', domain: 'help.noorg.test', domainType: 'subdomain', workspaceId: 'ws_hc_noorg' },
  ]);

  await tenantDb.insert(schema.helpcenterSettings).values([
    { id: 'hcs_old', isEnabled: 0, siteName: 'Old', createdAt: at(0), deletedAt: at(1) },
    {
      id: 'hcs_acme',
      isEnabled: 1,
      siteName: 'Acme Help',
      logo: 'https://cdn.acme.test/logo.png',
      primaryColor: '#112233',
      heroTitle: 'How can we help?',
      showSearch: 1,
      showCategories: 0,
      metaTitle: 'Acme Help Center',
      socialLinks: { twitter: 'https://x.test/acme' },
      customCss: 'body { color: red }',
      googleAnalyticsId: 'G-123',
      customDomain: DOMAIN,
      createdAt: at(1),
    },
  ]);

  await tenantDb.insert(schema.helpdeskArticleFolders).values([
    { id: 'fold_start', name: 'Getting started', sortOrder: 1, icon: 'rocket', description: 'First steps', createdAt: at(1) },
    { id: 'fold_billing', name: 'Billing', parentId: 'fold_start', sortOrder: 2, createdAt: at(2) },
    { id: 'fold_empty', name: 'Empty', sortOrder: 3, createdAt: at(3) },
    { id: 'fold_gone', name: 'Gone', sortOrder: 0, createdAt: at(4), deletedAt: at(5) },
  ]);

  await seedArticle('art_reset', 10, {
    title: 'Reset your password',
    slug: 'reset-password',
    content: 'Open settings and choose Reset.',
    excerpt: 'How to reset it',
    categoryId: 'fold_start',
    tags: ['account', 'login'],
    viewCount: 5,
    helpfulCount: 2,
    notHelpfulCount: 1,
  });
  await seedArticle('art_invoice', 20, { title: 'Pay an invoice', slug: 'pay-invoice', categoryId: 'fold_billing' });
  await seedArticle('art_contact', 5, {
    title: 'Contact support',
    slug: 'contact-support',
    content: 'Forgot your Password? Write to us. 100% answered.',
    viewCount: null,
    helpfulCount: null,
    notHelpfulCount: null,
  });
  await seedArticle('art_internal', 30, { title: 'Internal runbook: password', slug: 'runbook', visibility: 'internal', categoryId: 'fold_start' });
  await seedArticle('art_draft', 31, { title: 'Draft password tips', slug: 'draft', status: 'draft' });
  await seedArticle('art_deleted', 32, { title: 'Deleted password page', slug: 'deleted', deletedAt: at(40) });
}, 180_000);

afterEach(() => {
  kv.store.clear();
});

describe('domain resolution', () => {
  const ROUTES: Array<[string, RequestInit | undefined]> = [
    ['/config', undefined],
    ['/folders', undefined],
    ['/articles', undefined],
    ['/articles/reset-password', undefined],
    ['/articles/art_reset/feedback', json({ helpful: true })],
    ['/search', undefined],
  ];
  const withQuery = (path: string, query: string) => `${path}${query ? `?${query}` : ''}`;

  it('needs a domain', async () => {
    for (const [path, init] of ROUTES) {
      const res = await get(path, init);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Missing domain query parameter' } });
    }
  });

  it('404s a domain that is unknown, inactive, or whose workspace has no org', async () => {
    for (const [domain, message] of [
      ['nowhere.test', 'Help center not found for this domain'],
      ['old.acme.test', 'Help center not found for this domain'],
      ['help.noorg.test', 'Workspace not found'],
    ]) {
      for (const [path, init] of ROUTES) {
        const res = await get(withQuery(path, `domain=${domain}`), init);
        expect(res.status, `${domain} ${path}`).toBe(404);
        expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message } });
      }
    }
    expect(kv.store.size).toBe(0);
  });

  it('caches what a domain resolves to, and reads it back', async () => {
    expect((await get(`/config?${q}`)).status).toBe(200);
    expect(JSON.parse(kv.store.get(`hc:${DOMAIN}`)!)).toEqual({ workspaceId: 'ws_hc', clerkOrgId: 'org_hc' });

    // A cached domain is served without the registry.
    await kv.put('hc:cached.acme.test', JSON.stringify({ workspaceId: 'ws_hc', clerkOrgId: 'org_hc' }));
    expect((await get('/config?domain=cached.acme.test')).status).toBe(200);
  });
});

describe('GET /config', () => {
  it('answers the branding of an enabled help center', async () => {
    const res = await get(`/config?${q}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        siteName: 'Acme Help',
        logo: 'https://cdn.acme.test/logo.png',
        logoDark: null,
        favicon: null,
        primaryColor: '#112233',
        accentColor: null,
        heroTitle: 'How can we help?',
        heroSubtitle: null,
        showSearch: 1,
        showCategories: 0,
        metaTitle: 'Acme Help Center',
        metaDescription: null,
        ogImage: null,
        footerText: null,
        socialLinks: { twitter: 'https://x.test/acme' },
        customCss: 'body { color: red }',
        googleAnalyticsId: 'G-123',
      },
    });
  });

  it('404s a disabled help center', async () => {
    const settings = schema.helpcenterSettings;
    await tenantDb.update(settings).set({ isEnabled: 0 }).where(eq(settings.id, 'hcs_acme'));
    try {
      const res = await get(`/config?${q}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Help center is not enabled' } });
    } finally {
      await tenantDb.update(settings).set({ isEnabled: 1 }).where(eq(settings.id, 'hcs_acme'));
    }
  });
});

describe('GET /folders', () => {
  it('lists the live folders in order, counting their published public articles', async () => {
    const res = await get(`/folders?${q}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { id: 'fold_start', name: 'Getting started', parentId: null, sortOrder: 1, icon: 'rocket', description: 'First steps', articleCount: 1 },
        { id: 'fold_billing', name: 'Billing', parentId: 'fold_start', sortOrder: 2, icon: null, description: null, articleCount: 1 },
        { id: 'fold_empty', name: 'Empty', parentId: null, sortOrder: 3, icon: null, description: null, articleCount: 0 },
      ],
    });
  });
});

interface ArticleList {
  data: Array<Record<string, unknown>>;
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
}

const listIds = async (res: Response) => ((await res.json()) as ArticleList).data.map((a) => a.id);

describe('GET /articles', () => {
  it('lists published public articles, last updated first', async () => {
    const res = await get(`/articles?${q}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArticleList;
    expect(body.data.map((a) => a.id)).toEqual(['art_invoice', 'art_reset', 'art_contact']);
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, totalCount: 3, totalPages: 1, hasMore: false });
    expect(body.data[1]).toEqual({
      id: 'art_reset',
      title: 'Reset your password',
      slug: 'reset-password',
      excerpt: 'How to reset it',
      folderId: 'fold_start',
      viewCount: 5,
      helpfulCount: 2,
      notHelpfulCount: 1,
      tags: ['account', 'login'],
      createdAt: at(10).toISOString(),
      updatedAt: at(10).toISOString(),
    });
    expect(body.data[2]).toMatchObject({ folderId: null, viewCount: 0, helpfulCount: 0, notHelpfulCount: 0, tags: [], excerpt: null });
  });

  it('filters by folder and searches title, content and excerpt (case-sensitively, wildcards included)', async () => {
    expect(await listIds(await get(`/articles?${q}&folderId=fold_billing`))).toEqual(['art_invoice']);
    expect(await listIds(await get(`/articles?${q}&search=password`))).toEqual(['art_reset']);
    expect(await listIds(await get(`/articles?${q}&search=Password`))).toEqual(['art_contact']);
    expect(await listIds(await get(`/articles?${q}&search=reset%20it`))).toEqual(['art_reset']);
    expect(await listIds(await get(`/articles?${q}&search=%25`))).toEqual(['art_invoice', 'art_reset', 'art_contact']);
    expect(await listIds(await get(`/articles?${q}&search=password&folderId=fold_billing`))).toEqual([]);
  });

  it('pages, clamping the page size and reading junk as the defaults', async () => {
    const second = await get(`/articles?${q}&page=2&pageSize=2`);
    const body = (await second.json()) as ArticleList;
    expect(body.data.map((a) => a.id)).toEqual(['art_contact']);
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, totalCount: 3, totalPages: 2, hasMore: false });

    const first = (await (await get(`/articles?${q}&page=1&pageSize=2`)).json()) as ArticleList;
    expect(first.pagination.hasMore).toBe(true);

    const clamped = (await (await get(`/articles?${q}&page=0&pageSize=500`)).json()) as ArticleList;
    expect(clamped.pagination).toMatchObject({ page: 1, pageSize: 50 });
    const junk = (await (await get(`/articles?${q}&page=abc&pageSize=-3`)).json()) as ArticleList;
    expect(junk.pagination).toMatchObject({ page: 1, pageSize: 1, totalPages: 3, hasMore: true });
    const beyond = (await (await get(`/articles?${q}&page=9`)).json()) as ArticleList;
    expect(beyond).toMatchObject({ data: [], pagination: { page: 9, hasMore: false } });
  });
});

/** GET /articles/:slug counts a view: run it as a write on both backends. */
const readArticle = (slug: string) => get(`/articles/${slug}?${q}`, { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } });

describe('GET /articles/:slug', () => {
  it('answers the article and counts the view', async () => {
    const res = await readArticle('reset-password');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: 'art_reset',
        title: 'Reset your password',
        slug: 'reset-password',
        content: 'Open settings and choose Reset.',
        excerpt: 'How to reset it',
        folderId: 'fold_start',
        viewCount: 6,
        helpfulCount: 2,
        notHelpfulCount: 1,
        tags: ['account', 'login'],
        createdAt: at(10).toISOString(),
        updatedAt: at(10).toISOString(),
      },
    });
    const [row] = await tenantDb.select({ viewCount: articles.viewCount }).from(articles).where(eq(articles.id, 'art_reset'));
    expect(row!.viewCount).toBe(6);
  });

  it('answers 1 view for an article without a count, which stays without one', async () => {
    const res = await readArticle('contact-support');
    expect(((await res.json()) as { data: { viewCount: number } }).data.viewCount).toBe(1);
    // NULL + 1 is NULL: the stored count does not move.
    const [row] = await tenantDb.select({ viewCount: articles.viewCount }).from(articles).where(eq(articles.id, 'art_contact'));
    expect(row!.viewCount).toBeNull();
  });

  it('404s an internal, draft, deleted or unknown article', async () => {
    for (const slug of ['runbook', 'draft', 'deleted', 'nope']) {
      const res = await readArticle(slug);
      expect(res.status, slug).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Article not found' } });
    }
  });
});

describe('POST /articles/:id/feedback', () => {
  const feedback = (id: string, init: RequestInit) => get(`/articles/${id}/feedback?${q}`, init);
  const counts = async (id: string) =>
    (
      await tenantDb
        .select({ helpful: articles.helpfulCount, notHelpful: articles.notHelpfulCount })
        .from(articles)
        .where(eq(articles.id, id))
    )[0];

  it('counts helpful and not helpful answers (only `true` is helpful)', async () => {
    for (const body of [{ helpful: true }, { helpful: false }, { helpful: 'yes' }, {}]) {
      const res = await feedback('art_reset', json(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { recorded: true } });
    }
    expect(await counts('art_reset')).toEqual({ helpful: 3, notHelpful: 4 });
  });

  it('records feedback on a published internal article too', async () => {
    expect((await feedback('art_internal', json({ helpful: true }))).status).toBe(200);
    expect(await counts('art_internal')).toEqual({ helpful: 1, notHelpful: 0 });
  });

  it('refuses a body that is not JSON', async () => {
    const res = await feedback('art_reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'helpful' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid body' } });
  });

  it('404s an unpublished, deleted or unknown article', async () => {
    for (const id of ['art_draft', 'art_deleted', 'art_nope']) {
      const res = await feedback(id, json({ helpful: true }));
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Article with ID '${id}' not found` } });
    }
  });
});

describe('GET /search', () => {
  it('answers nothing for an empty query', async () => {
    for (const query of ['', '&q=', '&q=%20%20']) {
      const res = await get(`/search?${q}${query}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [], pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false } });
    }
  });

  it('searches published public articles, last updated first, paged', async () => {
    const res = await get(`/search?${q}&q=%20invoice%20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArticleList;
    expect(body).toEqual({
      data: [{ id: 'art_invoice', title: 'Pay an invoice', slug: 'pay-invoice', excerpt: null, folderId: 'fold_billing', tags: [], updatedAt: at(20).toISOString() }],
      pagination: { page: 1, pageSize: 20, totalCount: 1, totalPages: 1, hasMore: false },
    });

    expect(await listIds(await get(`/search?${q}&q=o`))).toEqual(['art_invoice', 'art_reset', 'art_contact']);
    const paged = (await (await get(`/search?${q}&q=o&page=2&pageSize=1`)).json()) as ArticleList;
    expect(paged.data.map((a) => a.id)).toEqual(['art_reset']);
    expect(paged.pagination).toEqual({ page: 2, pageSize: 1, totalCount: 3, totalPages: 3, hasMore: true });
    expect(await listIds(await get(`/search?${q}&q=Password`))).toEqual(['art_contact']);
    expect(await listIds(await get(`/search?${q}&q=_`))).toEqual(['art_invoice', 'art_reset', 'art_contact']);
  });
});

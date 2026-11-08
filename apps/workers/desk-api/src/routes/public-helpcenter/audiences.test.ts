/**
 * The public help center for a reader: audiences, language versions and
 * announcements, on pglite.
 *
 * The reader is anonymous unless the help center's server forwards a live
 * portal session (`x-portal-session`, kept hashed in the WORKSPACE_CACHE KV
 * by helpdesk-widget-api): then `logged_in` articles open, and `groups`
 * articles and `specific_groups` announcements open when the reader's
 * verified email is a CRM person at one of the audience's companies. Lists
 * show one entry per article, in `?locale=` when it has a published version
 * in that language. Conformance-ready like routes.test.ts: master, tenant
 * and the memory KV are shared with Rust.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { sha256Hex } from '@weldsuite/db/lib/desk-portal-session';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
}));

import { publicHelpcenterRoutes } from './index';

const BASE = '/public/helpcenter';
const DOMAIN = 'help.audience.test';
const q = `domain=${DOMAIN}`;
const articles = schema.helpdeskArticles;

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));
const PAST = new Date(Date.UTC(2000, 0, 1));
const FUTURE = new Date(Date.UTC(2999, 0, 1));

const token = (c: string) => c.repeat(64);
const ANN = token('a');
const BOB = token('b');
const EVE = token('e');
const EXPIRED = token('c');
const FOREIGN = token('d');
const MISMATCH = token('f');

function app() {
  return createTestApp(BASE, publicHelpcenterRoutes, {
    context: { tenantDb, masterDb: master, orgId: null, clerkOrgId: null },
    env: { WORKSPACE_CACHE: kv } as never,
  });
}

const as = (session?: string): RequestInit => (session ? { headers: { 'x-portal-session': session } } : {});
const get = (path: string, init?: RequestInit) => app().request(`${BASE}${path}`, init);

interface Listed {
  data: Array<{ id: string; slug: string; locale: string | null; folderId: string | null }>;
  pagination: { totalCount: number };
}
const ids = async (path: string, session?: string) => {
  const res = await get(path, as(session));
  expect(res.status, path).toBe(200);
  return ((await res.json()) as Listed).data.map((a) => a.id);
};

async function seedArticle(id: string, second: number, values: Partial<typeof articles.$inferInsert>) {
  await tenantDb.insert(articles).values({
    id,
    title: id,
    slug: id.replace(/_/g, '-'),
    content: `Content of ${id}`,
    authorId: 'user_author',
    status: 'published',
    visibility: 'public',
    createdAt: at(second),
    updatedAt: at(second),
    ...values,
  });
}

async function seedSession(value: string, session: Record<string, unknown>) {
  await kv.put(`dportal:sess:${await sha256Hex(value)}`, JSON.stringify(session));
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = tenantDb;

  await master.insert(masterSchema.workspaces).values({ id: 'ws_aud', clerkOrgId: 'org_aud', name: 'Audience', slug: 'audience' });
  await master.insert(masterSchema.helpcenterDomainRegistry).values({ id: 'hcd_aud', domain: DOMAIN, domainType: 'custom', workspaceId: 'ws_aud' });

  await tenantDb.insert(schema.helpcenterSettings).values({
    id: 'hcs_aud',
    isEnabled: 1,
    portalEnabled: 1,
    siteName: 'Audience Help',
    customDomain: DOMAIN,
    createdAt: at(0),
  });
  await tenantDb.insert(schema.helpdeskArticleFolders).values([
    { id: 'fold_guides', name: 'Guides', sortOrder: 1, createdAt: at(1) },
    { id: 'fold_private', name: 'Private', sortOrder: 2, createdAt: at(2) },
  ]);

  // CRM: Ann (email) and Bob (alternate email) at Acme; Bob left Acme for Other.
  await tenantDb.insert(schema.companies).values([
    { id: 'comp_acme', name: 'Acme', displayName: 'Acme' },
    { id: 'comp_other', name: 'Other', displayName: 'Other' },
    { id: 'comp_gone', name: 'Gone', displayName: 'Gone', deletedAt: at(3) },
  ]);
  await tenantDb.insert(schema.people).values([
    { id: 'per_ann', displayName: 'Ann', email: 'Ann@Acme.test' },
    { id: 'per_bob', displayName: 'Bob', email: 'robert@home.test', alternateEmails: ['bob@acme.test'] },
    { id: 'per_old', displayName: 'Old', email: 'eve@else.test', deletedAt: at(3) },
  ]);
  await tenantDb.insert(schema.personCompanies).values([
    { id: 'pc_ann', personId: 'per_ann', companyId: 'comp_acme' },
    { id: 'pc_ann_gone', personId: 'per_ann', companyId: 'comp_gone' },
    { id: 'pc_bob_left', personId: 'per_bob', companyId: 'comp_acme', endedAt: PAST },
    { id: 'pc_bob', personId: 'per_bob', companyId: 'comp_other' },
    { id: 'pc_old', personId: 'per_old', companyId: 'comp_acme' },
  ]);

  await tenantDb.insert(schema.deskVisitors).values([
    { id: 'dvis_ann', verifiedEmail: 'ann@acme.test' },
    { id: 'dvis_bob', verifiedEmail: 'bob@acme.test' },
    { id: 'dvis_eve', verifiedEmail: 'eve@else.test' },
  ]);
  const live = { workspaceId: 'ws_aud', expiresAt: FUTURE.toISOString() };
  await seedSession(ANN, { ...live, visitorId: 'dvis_ann', email: 'ann@acme.test' });
  await seedSession(BOB, { ...live, visitorId: 'dvis_bob', email: 'bob@acme.test' });
  await seedSession(EVE, { ...live, visitorId: 'dvis_eve', email: 'eve@else.test' });
  await seedSession(EXPIRED, { ...live, visitorId: 'dvis_ann', email: 'ann@acme.test', expiresAt: PAST.toISOString() });
  await seedSession(FOREIGN, { ...live, workspaceId: 'ws_elsewhere', visitorId: 'dvis_ann', email: 'ann@acme.test' });
  await seedSession(MISMATCH, { ...live, visitorId: 'dvis_eve', email: 'ann@acme.test' });

  await seedArticle('art_public', 10, { title: 'Public setup guide', categoryId: 'fold_guides' });
  await seedArticle('art_members', 11, { title: 'Members setup guide', visibility: 'logged_in', categoryId: 'fold_guides' });
  await seedArticle('art_acme', 12, { title: 'Acme setup guide', visibility: 'groups', audienceCompanyIds: ['comp_acme'], categoryId: 'fold_private' });
  await seedArticle('art_other', 13, { title: 'Other setup guide', visibility: 'groups', audienceCompanyIds: ['comp_other', 'comp_x'] });
  await seedArticle('art_nobody', 14, { title: 'Nobody setup guide', visibility: 'groups' });
  await seedArticle('art_internal', 15, { title: 'Internal setup guide', visibility: 'internal' });
  // Language versions.
  await seedArticle('art_public_nl', 20, { title: 'Openbare installatiegids', locale: 'nl', translationOfId: 'art_public' });
  await seedArticle('art_public_de', 21, { title: 'Offentliche Anleitung', locale: 'de', translationOfId: 'art_public', status: 'draft' });
  await seedArticle('art_members_nl', 22, { title: 'Ledengids voor installatie', locale: 'nl', translationOfId: 'art_members', visibility: 'logged_in' });
  await seedArticle('art_draft_original', 23, { title: 'Unpublished original', status: 'draft' });
  await seedArticle('art_orphan_fr', 24, { title: 'Guide orphelin', locale: 'fr', translationOfId: 'art_draft_original' });

  const ann = schema.helpdeskAnnouncements;
  const announcement = (id: string, second: number, values: Partial<typeof ann.$inferInsert>) => ({
    id,
    title: `Title ${id}`,
    content: `Content ${id}`,
    authorId: 'user_author',
    status: 'published',
    visibility: 'public',
    publishedAt: at(second),
    createdAt: at(second),
    updatedAt: at(second),
    ...values,
  });
  await tenantDb.insert(ann).values([
    announcement('ann_public', 30, { type: 'info', excerpt: 'Short' }),
    announcement('ann_pinned', 20, { type: 'warning', isPinned: true, expiresAt: FUTURE }),
    announcement('ann_acme', 40, { type: 'error', visibility: 'specific_groups', targetGroups: ['comp_acme'] }),
    announcement('ann_internal', 41, { visibility: 'internal' }),
    announcement('ann_draft', 42, { status: 'draft' }),
    announcement('ann_expired', 43, { expiresAt: PAST }),
    announcement('ann_scheduled', 44, { publishedAt: FUTURE }),
    announcement('ann_deleted', 45, { deletedAt: at(46) }),
    announcement('ann_unstamped', 10, { type: 'success', publishedAt: null }),
  ]);
}, 180_000);

describe('readers', () => {
  it('shows an anonymous reader the public articles only', async () => {
    expect(await ids(`/articles?${q}`)).toEqual(['art_public']);
  });

  it('opens logged_in articles to a signed-in reader, groups ones to the readers at their companies', async () => {
    expect(await ids(`/articles?${q}`, ANN)).toEqual(['art_acme', 'art_members', 'art_public']);
    // Bob matches by his alternate email; he left Acme, so only Other counts.
    expect(await ids(`/articles?${q}`, BOB)).toEqual(['art_other', 'art_members', 'art_public']);
    // Eve's CRM person is deleted: signed in, no companies.
    expect(await ids(`/articles?${q}`, EVE)).toEqual(['art_members', 'art_public']);
  });

  it('reads a session that is unknown, expired, for another workspace or no longer verified as anonymous', async () => {
    for (const session of [token('9'), EXPIRED, FOREIGN, MISMATCH, 'not-a-token']) {
      expect(await ids(`/articles?${q}`, session), session).toEqual(['art_public']);
    }
  });

  it('reads every session as anonymous while sign-in is off', async () => {
    const settings = schema.helpcenterSettings;
    await tenantDb.update(settings).set({ portalEnabled: 0 }).where(eq(settings.id, 'hcs_aud'));
    try {
      expect(await ids(`/articles?${q}`, ANN)).toEqual(['art_public']);
    } finally {
      await tenantDb.update(settings).set({ portalEnabled: 1 }).where(eq(settings.id, 'hcs_aud'));
    }
  });

  it('counts the articles a reader may open per folder', async () => {
    const counts = async (session?: string) => {
      const res = await get(`/folders?${q}`, as(session));
      return ((await res.json()) as { data: Array<{ id: string; articleCount: number }> }).data.map((f) => [f.id, f.articleCount]);
    };
    expect(await counts()).toEqual([['fold_guides', 1], ['fold_private', 0]]);
    expect(await counts(ANN)).toEqual([['fold_guides', 2], ['fold_private', 1]]);
    expect(await counts(BOB)).toEqual([['fold_guides', 2], ['fold_private', 0]]);
  });

  it('searches only what the reader may open', async () => {
    expect(await ids(`/search?${q}&q=setup%20guide`)).toEqual(['art_public']);
    const signedIn = await ids(`/search?${q}&q=setup%20guide`, ANN);
    expect([...signedIn].sort()).toEqual(['art_acme', 'art_members', 'art_public']);
    expect(await ids(`/search?${q}&q=internal`, ANN)).toEqual([]);
  });

  it('opens an article only to its readers', async () => {
    const read = (slug: string, session?: string) =>
      get(`/articles/${slug}?${q}`, { headers: { [CONFORMANCE_WRITE_HEADER]: '1', ...(session ? { 'x-portal-session': session } : {}) } });
    expect((await read('art-members')).status).toBe(404);
    expect((await read('art-members', EVE)).status).toBe(200);
    expect((await read('art-acme', EVE)).status).toBe(404);
    expect((await read('art-acme', ANN)).status).toBe(200);
    expect((await read('art-nobody', ANN)).status).toBe(404);
    expect((await read('art-internal', ANN)).status).toBe(404);
  });
});

describe('language versions', () => {
  it('lists the version in the reader language, one entry per article, in the original folder', async () => {
    const res = await get(`/articles?${q}&locale=nl`);
    const body = (await res.json()) as Listed;
    expect(body.data.map((a) => [a.id, a.locale, a.folderId])).toEqual([['art_public_nl', 'nl', 'fold_guides']]);
    expect(body.pagination.totalCount).toBe(1);
    expect(await ids(`/articles?${q}&locale=NL`, ANN)).toEqual(['art_members_nl', 'art_public_nl', 'art_acme']);
    expect(await ids(`/articles?${q}&locale=nl&folderId=fold_guides`, ANN)).toEqual(['art_members_nl', 'art_public_nl']);
    // A draft version is never shown: the original stands in.
    expect(await ids(`/articles?${q}&locale=de`)).toEqual(['art_public']);
  });

  it('searches the versions a reader sees in their language', async () => {
    expect(await ids(`/search?${q}&q=installatie&locale=nl`)).toEqual(['art_public_nl']);
    expect(await ids(`/search?${q}&q=installatie`)).toEqual([]);
    expect(await ids(`/search?${q}&q=setup&locale=nl`, ANN)).toEqual(['art_acme']);
  });

  it('answers a version with links to every version the reader may open', async () => {
    const read = (slug: string, session?: string) =>
      get(`/articles/${slug}?${q}`, { headers: { [CONFORMANCE_WRITE_HEADER]: '1', ...(session ? { 'x-portal-session': session } : {}) } });
    const res = await read('art-public-nl');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: 'art_public_nl', locale: 'nl', folderId: 'fold_guides' });
    expect(data.versions).toEqual([
      { locale: null, slug: 'art-public', title: 'Public setup guide' },
      { locale: 'nl', slug: 'art-public-nl', title: 'Openbare installatiegids' },
    ]);
    const original = (await (await read('art-public')).json()) as { data: { versions: unknown[] } };
    expect(original.data.versions).toHaveLength(2);
    // A version of an unpublished original is not served.
    expect((await read('art-orphan-fr')).status).toBe(404);
    expect((await read('art-public-de')).status).toBe(404);
  });
});

describe('GET /announcements', () => {
  const list = async (session?: string) => {
    const res = await get(`/announcements?${q}`, as(session));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
  };

  it('answers the published, started, unexpired public announcements, pinned first, newest first', async () => {
    const data = await list();
    expect(data.map((a) => a.id)).toEqual(['ann_pinned', 'ann_public', 'ann_unstamped']);
    expect(data[0]).toEqual({
      id: 'ann_pinned',
      title: 'Title ann_pinned',
      content: 'Content ann_pinned',
      excerpt: null,
      type: 'warning',
      isPinned: true,
      publishedAt: at(20).toISOString(),
      expiresAt: FUTURE.toISOString(),
    });
    expect(data[2]).toMatchObject({ isPinned: false, publishedAt: null, type: 'success' });
  });

  it('adds the ones for the reader’s companies', async () => {
    expect((await list(ANN)).map((a) => a.id)).toEqual(['ann_pinned', 'ann_acme', 'ann_public', 'ann_unstamped']);
    expect((await list(BOB)).map((a) => a.id)).toEqual(['ann_pinned', 'ann_public', 'ann_unstamped']);
  });
});

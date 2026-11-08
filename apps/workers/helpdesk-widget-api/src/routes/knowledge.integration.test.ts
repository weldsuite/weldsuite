/**
 * Self-service in the widget on pglite: article search before a visitor sends
 * their first message, and the status banners. The visitor token is optional:
 * a known visitor with a verified email also gets `logged_in` articles and,
 * through their CRM companies, `groups` articles and `specific_groups`
 * announcements; a token that doesn't hold reads as anonymous.
 *
 * Conformance-ready ("desk: helpdesk widget"): master and tenant databases are
 * shared with the Rust backend, every id and time is fixed, and dates that
 * must be past or future are far from today.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { identitySecretFingerprint } from '../lib/visitor-identity';
import {
  IDENTITY_SECRET,
  WIDGET,
  addWidget,
  at,
  get,
  getAs,
  seedWorkspaces,
  visitorRow,
  visitorToken,
  widgetEnv,
} from '../test/widget-fixtures';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const OTHER_WIDGET = 'wdg_other';
const PAST = new Date(Date.UTC(2000, 0, 1));
const FUTURE = new Date(Date.UTC(2999, 0, 1));

let tenantDb: Database;
let masterDb: Database;
let anonToken: string;
let annToken: string;
let portalToken: string;
let otherWidgetToken: string;
let staleIdentityToken: string;

function app() {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: '/public/helpdesk-widget',
  });
}

interface Hit {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  url: string | null;
}

async function search(query: string, token?: string): Promise<Hit[]> {
  const init = token ? getAs(token) : get();
  const res = await app().request(`/api/articles/search${query}`, init);
  expect(res.status, query).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Hit[] };
  expect(body.success).toBe(true);
  return body.data;
}

const ids = (hits: Hit[]) => hits.map((h) => h.id);

async function seedArticle(id: string, second: number, values: Partial<typeof tenantSchema.helpdeskArticles.$inferInsert>) {
  await tenantDb.insert(tenantSchema.helpdeskArticles).values({
    id,
    title: id,
    slug: id.replace(/_/g, '-'),
    content: `<p>Content of ${id}</p>`,
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
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET, { settings: { identitySecret: IDENTITY_SECRET } });
  await addWidget(masterDb, tenantDb, OTHER_WIDGET);

  await tenantDb.insert(tenantSchema.helpcenterSettings).values({
    id: 'hcs_w',
    isEnabled: 1,
    defaultSubdomain: 'acme.welddesk.org',
    customDomain: 'help.acme.test',
    createdAt: at(0),
  });

  await tenantDb.insert(tenantSchema.companies).values([{ id: 'comp_acme', name: 'Acme', displayName: 'Acme' }]);
  await tenantDb.insert(tenantSchema.people).values([{ id: 'per_ann', displayName: 'Ann', email: 'ann@acme.test' }]);
  await tenantDb.insert(tenantSchema.personCompanies).values([{ id: 'pc_ann', personId: 'per_ann', companyId: 'comp_acme' }]);

  await tenantDb.insert(tenantSchema.deskVisitors).values([
    visitorRow('dvis_anon'),
    visitorRow('dvis_ann', { externalId: 'user-ann', verifiedEmail: 'ann@acme.test' }),
    visitorRow('dvis_portal', { verifiedEmail: 'zed@else.test' }),
    visitorRow('dvis_other', { widgetId: OTHER_WIDGET, verifiedEmail: 'ann@acme.test' }),
  ]);
  const fingerprint = await identitySecretFingerprint(IDENTITY_SECRET);
  anonToken = await visitorToken('dvis_anon');
  annToken = await visitorToken('dvis_ann', { secretFingerprint: fingerprint });
  portalToken = await visitorToken('dvis_portal');
  otherWidgetToken = await visitorToken('dvis_other', { widgetId: OTHER_WIDGET });
  staleIdentityToken = await visitorToken('dvis_ann', { secretFingerprint: 'a-rotated-away-secret' });

  await seedArticle('art_reset', 10, { title: 'Reset your password', excerpt: 'Forgot it?' });
  await seedArticle('art_login', 11, { title: 'Password rules for members', visibility: 'logged_in' });
  await seedArticle('art_acme', 12, { title: 'Acme password policy', visibility: 'groups', audienceCompanyIds: ['comp_acme'] });
  await seedArticle('art_internal', 13, { title: 'Internal password vault', visibility: 'internal' });
  await seedArticle('art_draft', 14, { title: 'Draft password page', status: 'draft' });
  await seedArticle('art_reset_nl', 15, { title: 'Wachtwoord resetten', content: '<p>password</p>', locale: 'nl', translationOfId: 'art_reset' });
  await seedArticle('art_billing', 16, { title: 'Billing and invoices' });

  const ann = tenantSchema.helpdeskAnnouncements;
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
    announcement('ann_outage', 30, { type: 'error', isPinned: true }),
    announcement('ann_release', 31, { type: 'success', excerpt: 'New things' }),
    announcement('ann_acme', 32, { type: 'warning', visibility: 'specific_groups', targetGroups: ['comp_acme'], expiresAt: FUTURE }),
    announcement('ann_internal', 33, { visibility: 'internal' }),
    announcement('ann_expired', 34, { expiresAt: PAST }),
    announcement('ann_draft', 35, { status: 'draft' }),
  ]);
}, 180_000);

describe('GET /api/articles/search', () => {
  it('finds the published public articles an anonymous visitor may read, with their help-center links', async () => {
    const hits = await search('?q=password', anonToken);
    expect(ids(hits)).toEqual(['art_reset']);
    expect(hits[0]).toEqual({
      id: 'art_reset',
      title: 'Reset your password',
      slug: 'art-reset',
      excerpt: 'Forgot it?',
      url: 'https://help.acme.test/articles/art-reset',
    });
    // No token at all is anonymous too.
    expect(ids(await search('?q=passw'))).toEqual(['art_reset']);
  });

  it('answers nothing for an empty query or one without words', async () => {
    for (const query of ['', '?q=', '?q=%20%20', '?q=%3F%21']) {
      expect(await search(query), query).toEqual([]);
    }
  });

  it('adds logged_in articles for a verified visitor, groups ones for their companies', async () => {
    expect(ids(await search('?q=password', annToken)).sort()).toEqual(['art_acme', 'art_login', 'art_reset']);
    expect(ids(await search('?q=password', portalToken)).sort()).toEqual(['art_login', 'art_reset']);
  });

  it('reads a token that does not hold as anonymous', async () => {
    for (const token of [otherWidgetToken, staleIdentityToken, 'not-a-token']) {
      expect(ids(await search('?q=password', token))).toEqual(['art_reset']);
    }
  });

  it('prefers the version in the visitor’s language', async () => {
    expect(ids(await search('?q=password&locale=nl'))).toEqual(['art_reset_nl']);
    expect(ids(await search('?q=wachtwoord&locale=NL'))).toEqual(['art_reset_nl']);
    expect(ids(await search('?q=wachtwoord'))).toEqual([]);
  });

  it('keeps the limit between 1 and 5, 3 by default', async () => {
    expect(await search('?q=password&limit=0', annToken)).toHaveLength(1);
    expect(await search('?q=password&limit=2', annToken)).toHaveLength(2);
    expect(await search('?q=password&limit=abc', annToken)).toHaveLength(3);
    expect(await search('?q=password&limit=99', annToken)).toHaveLength(3);
  });

  it('answers no links while the help center is off', async () => {
    const settings = tenantSchema.helpcenterSettings;
    await tenantDb.update(settings).set({ isEnabled: 0 }).where(eq(settings.id, 'hcs_w'));
    try {
      expect((await search('?q=billing'))[0]).toMatchObject({ id: 'art_billing', url: null });
    } finally {
      await tenantDb.update(settings).set({ isEnabled: 1 }).where(eq(settings.id, 'hcs_w'));
    }
  });
});

describe('GET /api/announcements', () => {
  const list = async (token?: string) => {
    const res = await app().request('/api/announcements', token ? getAs(token) : get());
    expect(res.status).toBe(200);
    return ((await res.json()) as { success: boolean; data: Array<Record<string, unknown>> }).data;
  };

  it('answers the published, unexpired public announcements, pinned first', async () => {
    const data = await list();
    expect(data.map((a) => a.id)).toEqual(['ann_outage', 'ann_release']);
    expect(data[1]).toEqual({
      id: 'ann_release',
      title: 'Title ann_release',
      content: 'Content ann_release',
      excerpt: 'New things',
      type: 'success',
      isPinned: false,
      publishedAt: at(31).toISOString(),
      expiresAt: null,
    });
  });

  it('adds the ones for a known visitor’s companies', async () => {
    expect((await list(annToken)).map((a) => a.id)).toEqual(['ann_outage', 'ann_acme', 'ann_release']);
    expect((await list(portalToken)).map((a) => a.id)).toEqual(['ann_outage', 'ann_release']);
  });
});

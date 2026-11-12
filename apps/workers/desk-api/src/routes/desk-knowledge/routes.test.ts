/**
 * Knowledge inside the inbox on pglite: article suggestions for a
 * conversation (related to the customer's latest messages, or a search) and a
 * draft article from the conversation. Runs against Rust in conformance mode
 * (rust/conformance/suites.json, "desk: knowledge base"), so every seed has a
 * fixed id and time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskKnowledgeRoutes } from './index';

const BASE = '/api/desk/conversations';
const articles = schema.helpdeskArticles;

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, deskKnowledgeRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_agent' },
  });
const READ = ['conversations:read', 'articles:read'];
const CREATE = ['conversations:read', 'articles:create'];

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

interface Suggestions {
  data: {
    helpCenterUrl: string | null;
    query: string;
    articles: Array<{ id: string; title: string; slug: string; excerpt: string | null; visibility: string; locale: string | null; url: string | null }>;
  };
}

async function suggest(path: string): Promise<Suggestions['data']> {
  const res = await app(...READ).request(`${BASE}${path}`);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as Suggestions).data;
}

async function seedArticle(id: string, second: number, values: Partial<typeof articles.$inferInsert>) {
  await db.insert(articles).values({
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
  db = (await createPgliteDb()).db;
  await db.insert(schema.helpcenterSettings).values({
    id: 'hcs_k',
    isEnabled: 1,
    defaultSubdomain: 'Acme.welddesk.org',
    createdAt: at(0),
  });
  await db.insert(schema.deskConversations).values([
    { id: 'dcon_reset', conversationNumber: 1, title: null, createdAt: at(1), updatedAt: at(1) },
    { id: 'dcon_titled', conversationNumber: 2, title: '  Invoice question  ', createdAt: at(2), updatedAt: at(2) },
    { id: 'dcon_empty', conversationNumber: 3, createdAt: at(3), updatedAt: at(3) },
  ]);
  const message = (id: string, conversationId: string, second: number, values: Partial<typeof schema.deskMessages.$inferInsert>) => ({
    id,
    conversationId,
    kind: 'message' as const,
    authorType: 'visitor' as const,
    createdAt: at(second),
    ...values,
  });
  await db.insert(schema.deskMessages).values([
    message('dmsg_1', 'dcon_reset', 10, { body: 'Hi there\nI can\'t log in to my account <b>at all</b>' }),
    message('dmsg_2', 'dcon_reset', 11, { body: 'Thanks, how do I reset the password?', authorType: 'agent', kind: 'note' }),
    message('dmsg_3', 'dcon_reset', 12, { body: 'Open Settings & choose "Reset password".\r\nThen sign in again.', authorType: 'agent' }),
    message('dmsg_4', 'dcon_reset', 13, { body: 'How do I reset my password?' }),
    message('dmsg_5', 'dcon_reset', 14, { kind: 'event', authorType: 'system', body: null, metadata: { eventType: 'closed' } }),
    message('dmsg_6', 'dcon_reset', 15, { body: 'A bot answer', authorType: 'bot' }),
    message('dmsg_7', 'dcon_titled', 20, { body: 'Where is my invoice for March?' }),
  ]);

  await seedArticle('art_reset', 30, { title: 'Reset your password', excerpt: 'Forgot it? Reset it.' });
  await seedArticle('art_login', 31, { title: 'Trouble signing in', content: '<p>If you cannot <b>log</b> in, reset your password.</p>', visibility: 'logged_in', locale: 'en' });
  await seedArticle('art_reset_nl', 32, { title: 'Wachtwoord resetten', content: '<p>password</p>', locale: 'nl', translationOfId: 'art_reset', visibility: 'groups', audienceCompanyIds: ['comp_a'] });
  await seedArticle('art_internal', 33, { title: 'Internal password reset runbook', visibility: 'internal' });
  // A public version of an internal original: the help center serves neither, so it is never suggested.
  await seedArticle('art_internal_nl', 38, { title: 'Intern wachtwoord resetten', content: '<p>password reset</p>', locale: 'nl', translationOfId: 'art_internal' });
  await seedArticle('art_draft', 34, { title: 'Draft password article', status: 'draft' });
  await seedArticle('art_deleted', 35, { title: 'Deleted password article', deletedAt: at(36) });
  await seedArticle('art_invoice', 37, { title: 'Find your invoices', excerpt: 'Billing' });
}, 60_000);

describe('GET /:id/article-suggestions', () => {
  it('suggests published, shareable articles related to the customer’s latest messages', async () => {
    const data = await suggest('/dcon_reset/article-suggestions');
    expect(data.helpCenterUrl).toBe('https://acme.welddesk.org');
    expect(data.query).toBe('');
    expect(data.articles.map((a) => a.id).sort()).toEqual(['art_login', 'art_reset', 'art_reset_nl']);
    expect(data.articles.find((a) => a.id === 'art_reset')).toEqual({
      id: 'art_reset',
      title: 'Reset your password',
      slug: 'art-reset',
      excerpt: 'Forgot it? Reset it.',
      visibility: 'public',
      locale: null,
      url: 'https://acme.welddesk.org/articles/art-reset',
    });
    expect((await suggest('/dcon_titled/article-suggestions')).articles.map((a) => a.id)).toEqual(['art_invoice']);
    expect((await suggest('/dcon_empty/article-suggestions')).articles).toEqual([]);
  });

  it('searches with q, best match first, within the limit', async () => {
    const data = await suggest('/dcon_reset/article-suggestions?q=%20passw%20');
    expect(data.query).toBe('passw');
    expect(data.articles[0]?.id).toBe('art_reset');
    expect(data.articles.map((a) => a.id).sort()).toEqual(['art_login', 'art_reset', 'art_reset_nl']);
    expect((await suggest('/dcon_reset/article-suggestions?q=password&limit=1')).articles.map((a) => a.id)).toEqual(['art_reset']);
    expect((await suggest('/dcon_reset/article-suggestions?q=invoices')).articles.map((a) => a.id)).toEqual(['art_invoice']);
    expect((await suggest('/dcon_reset/article-suggestions?q=runbook')).articles).toEqual([]);
    expect((await suggest('/dcon_reset/article-suggestions?q=%3F%3F')).articles).toEqual([]);
  });

  it('answers no links while the help center is off', async () => {
    await db.update(schema.helpcenterSettings).set({ isEnabled: 0 }).where(eq(schema.helpcenterSettings.id, 'hcs_k'));
    try {
      const data = await suggest('/dcon_reset/article-suggestions?q=reset');
      expect(data.helpCenterUrl).toBeNull();
      expect(data.articles.every((a) => a.url === null)).toBe(true);
    } finally {
      await db.update(schema.helpcenterSettings).set({ isEnabled: 1 }).where(eq(schema.helpcenterSettings.id, 'hcs_k'));
    }
  });

  it('refuses a bad limit, an unknown conversation and a caller without both permissions', async () => {
    for (const limit of ['0', '11', 'abc', '2.5']) {
      expect((await app(...READ).request(`${BASE}/dcon_reset/article-suggestions?limit=${limit}`)).status, limit).toBe(400);
    }
    const missing = await app(...READ).request(`${BASE}/dcon_nope/article-suggestions`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Conversation with ID 'dcon_nope' not found" } });
    expect((await app('articles:read').request(`${BASE}/dcon_reset/article-suggestions`)).status).toBe(403);
    expect((await app('conversations:read').request(`${BASE}/dcon_reset/article-suggestions`)).status).toBe(403);
  });
});

describe('POST /:id/draft-article', () => {
  const draft = (id: string, ...keys: string[]) =>
    app(...(keys.length ? keys : CREATE)).request(`${BASE}/${id}/draft-article`, { method: 'POST' });

  it('drafts an article from the customer’s question and the team’s public answers', async () => {
    const res = await draft('dcon_reset');
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      title: 'Hi there',
      status: 'draft',
      visibility: 'public',
      audienceCompanyIds: [],
      authorId: 'user_agent',
      isDraft: true,
      publishedAt: null,
      relatedTickets: ['dcon_reset'],
      excerpt: "Hi there I can't log in to my account <b>at all</b>",
      translationOfId: null,
      locale: null,
    });
    expect(data.content).toBe(
      '<blockquote><p>Hi there<br>I can&#39;t log in to my account &lt;b&gt;at all&lt;/b&gt;</p><p>How do I reset my password?</p></blockquote>' +
        '<p>Open Settings &amp; choose &quot;Reset password&quot;.<br>Then sign in again.</p>',
    );
    expect(String(data.slug)).toMatch(/^hi-there-/);
    const [stored] = await db.select().from(articles).where(eq(articles.id, String(data.id)));
    expect(stored?.title).toBe('Hi there');
  });

  it('takes the conversation’s title when it has one, else its number', async () => {
    const titled = (await (await draft('dcon_titled')).json()) as { data: Record<string, unknown> };
    expect(titled.data).toMatchObject({ title: 'Invoice question', excerpt: 'Where is my invoice for March?' });
    const empty = (await (await draft('dcon_empty')).json()) as { data: Record<string, unknown> };
    expect(empty.data).toMatchObject({ title: '#3', excerpt: null, content: '<p></p>' });
  });

  it('refuses an unknown conversation and a caller without both permissions', async () => {
    expect((await draft('dcon_nope')).status).toBe(404);
    expect((await draft('dcon_reset', 'articles:create')).status).toBe(403);
    expect((await draft('dcon_reset', 'conversations:read', 'articles:read')).status).toBe(403);
  });
});

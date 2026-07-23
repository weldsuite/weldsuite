/**
 * DB-backed integration tests for /api/articles.
 *
 * The route bridges the schema/Zod naming mismatch: DB has `content`
 * + `slug` (both NOT NULL), Zod calls the body `body`/`bodyHtml` and
 * makes slug optional. The route picks the first available body
 * field and slugifies the title.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { articlesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/articles · pglite integration', () => {
  it('POST / writes an article and derives slug from title + content from body', async () => {
    const { request } = createTestApp('/api/articles', articlesRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });

    const res = await request('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'How to start using WeldSuite',
        body: 'Sign up, pick a plan, go!',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^art_/);

    const [row] = await db
      .select()
      .from(schema.helpdeskArticles)
      .where(eq(schema.helpdeskArticles.id, body.data.id))
      .limit(1);
    expect(row?.title).toBe('How to start using WeldSuite');
    // The route appends a short unique suffix (`-<id fragment>`) to every slug.
    expect(row?.slug).toMatch(/^how-to-start-using-weldsuite-[a-z0-9]{6}$/);
    expect(row?.content).toBe('Sign up, pick a plan, go!');
  });

  it('POST / accepts an explicit slug + content', async () => {
    const { request } = createTestApp('/api/articles', articlesRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });
    const res = await request('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Anything',
        slug: 'custom-article-slug',
        content: 'Explicit content',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.helpdeskArticles)
      .where(eq(schema.helpdeskArticles.id, body.data.id))
      .limit(1);
    // Even an explicit slug gets the uniqueness suffix appended.
    expect(row?.slug).toMatch(/^custom-article-slug-[a-z0-9]{6}$/);
    expect(row?.content).toBe('Explicit content');
  });

  it('POST / rejects empty title', async () => {
    const { request } = createTestApp('/api/articles', articlesRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });
    const res = await request('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });
});

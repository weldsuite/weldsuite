/**
 * DB-backed integration tests for /api/article-folders.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { articleFoldersRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/article-folders · pglite integration', () => {
  it('POST / writes an article folder row', async () => {
    const { request } = createTestApp('/api/article-folders', articleFoldersRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });

    const res = await request('/api/article-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Getting Started',
        color: '#10b981',
        icon: 'BookOpen',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskArticleFolders)
      .where(eq(schema.helpdeskArticleFolders.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Getting Started');
    expect(row?.color).toBe('#10b981');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/article-folders', articleFoldersRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });
    const res = await request('/api/article-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

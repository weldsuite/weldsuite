/**
 * DB-backed integration tests for /api/task-tags.
 *
 * Task tags are personal (user-scoped). Every read and write must be confined
 * to the calling user's tags — another user's tags must surface as 404.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { taskTagsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

// Helper: insert a raw tag for a given user.
async function seedTag(
  database: Database,
  id: string,
  userId: string,
  name: string,
) {
  const now = new Date();
  await database
    .insert(schema.taskTags)
    .values({ id, userId, name, createdAt: now, updatedAt: now } as typeof schema.taskTags.$inferInsert)
    .onConflictDoNothing();
}

describe('/api/task-tags · pglite integration', () => {
  it('POST / writes a tag scoped to the caller userId', async () => {
    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:create'),
        userId: 'user_tagger',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'urgent', color: '#ff0000' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^ttag_/);

    const [row] = await db
      .select()
      .from(schema.taskTags)
      .where(
        and(
          eq(schema.taskTags.id, body.data.id),
          eq(schema.taskTags.userId, 'user_tagger'),
        ),
      )
      .limit(1);
    expect(row?.name).toBe('urgent');
    expect(row?.color).toBe('#ff0000');
  });

  it('GET / returns only the caller\'s own tags', async () => {
    await seedTag(db, 'ttag_ann_own', 'user_ann', 'ann-tag');
    await seedTag(db, 'ttag_ben_own', 'user_ben', 'ben-tag');

    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:read'),
        userId: 'user_ann',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain('ttag_ann_own');
    expect(ids).not.toContain('ttag_ben_own');
    for (const row of body.data) {
      expect(row.userId).toBe('user_ann');
    }
  });

  it('GET /:id returns 404 when the tag belongs to a different user', async () => {
    await seedTag(db, 'ttag_carl_own', 'user_carl', 'carl-tag');

    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:read'),
        userId: 'user_diana',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags/ttag_carl_own');
    expect(res.status).toBe(404);
  });

  it('PATCH /:id returns 404 when the caller does not own the tag', async () => {
    await seedTag(db, 'ttag_ed_own', 'user_ed', 'ed-tag');

    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:update'),
        userId: 'user_fran',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags/ttag_ed_own', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id returns 404 when the caller does not own the tag', async () => {
    await seedTag(db, 'ttag_george_own', 'user_george', 'george-tag');

    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:delete'),
        userId: 'user_helen',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags/ttag_george_own', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('PATCH /:id updates a tag the caller owns', async () => {
    await seedTag(db, 'ttag_ivan_own', 'user_ivan', 'ivan-tag');

    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: {
        permissions: permissions('tasks:update'),
        userId: 'user_ivan',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-tags/ttag_ivan_own', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ivan-updated' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/task-tags', taskTagsRoutes, {
      context: { permissions: permissions('tasks:create'), tenantDb: db },
    });
    const res = await request('/api/task-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

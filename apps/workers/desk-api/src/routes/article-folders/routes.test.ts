/**
 * Every /api/article-folders route on pglite: the shared CRUD suite
 * (../../test/crud-suite.ts) plus the folder specifics (passthrough columns,
 * the parent filter, clearing a parent). Runs against Rust in conformance mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { articleFoldersRoutes } from './index';

const BASE = '/api/article-folders';
const t = schema.helpdeskArticleFolders;

describeCrud(BASE, {
  base: BASE,
  routes: articleFoldersRoutes,
  table: t,
  gates: { read: 'articles:read', create: 'articles:create', update: 'articles:update', delete: 'articles:delete' },
  seed: (n) => ({ name: `Folder ${n}` }),
  valid: { name: 'Getting Started', color: '#10b981', icon: 'BookOpen', sortOrder: 1, parentId: null, isPublic: true },
  // The schema allows a 50-character color, the column 20.
  unstorable: { name: 'Too colorful', color: 'x'.repeat(30) },
  invalid: [
    {},
    { name: '' },
    { name: 'x'.repeat(256) },
    { name: 'x', sortOrder: 1.5 },
    { name: 'x', isPublic: 'yes' },
    { name: 'x', parentId: 5 },
    { name: 'x', icon: 'x'.repeat(101) },
  ],
  patch: { name: 'Renamed', description: 'Docs' },
  invalidPatch: { sortOrder: 'first' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle folder' } },
    { query: 'parentId=afld_parent', match: { parentId: 'afld_parent' } },
  ],
});

describe('/api/article-folders · folder specifics', () => {
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, articleFoldersRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));
  const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(t).values([
      { id: 'afld_root', name: 'Root', createdAt: at(1), updatedAt: at(1) },
      { id: 'afld_child', name: 'Child', parentId: 'afld_root', path: 'root/child', level: 1, createdAt: at(2), updatedAt: at(2) },
      { id: 'afld_gone', name: 'Gone', parentId: 'afld_root', deletedAt: at(4), createdAt: at(3), updatedAt: at(3) },
    ]);
  }, 60_000);

  it('GET / answers the full rows; an empty parentId is no filter', async () => {
    // createPgliteDb() is one database per file: the CRUD suite's rows are here too.
    const { request } = app('articles:read');
    type Page = { data: Array<Record<string, unknown>>; pagination: { totalCount: number } };
    const unfiltered = (await (await request(`${BASE}?limit=100`)).json()) as Page;
    const emptyParent = (await (await request(`${BASE}?limit=100&parentId=`)).json()) as Page;
    expect(emptyParent.pagination.totalCount).toBe(unfiltered.pagination.totalCount);
    expect(emptyParent.data.map((r) => r.id)).toEqual(unfiltered.data.map((r) => r.id));
    const detail = (await (await request(`${BASE}/afld_child`)).json()) as { data: Record<string, unknown> };
    expect(detail.data).toMatchObject({
      name: 'Child',
      parentId: 'afld_root',
      path: 'root/child',
      level: 1,
      sortOrder: 0,
      articleCount: 0,
      slug: null,
      color: null,
    });
    const children = (await (await request(`${BASE}?parentId=afld_root`)).json()) as {
      data: Array<{ id: string }>;
      pagination: { totalCount: number };
    };
    expect(children.data.map((r) => r.id)).toEqual(['afld_child']);
    expect(children.pagination.totalCount).toBe(1);
  });

  it('GET /:id 404 names the folder', async () => {
    const res = await app('articles:read').request(`${BASE}/afld_gone`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Article folder with ID 'afld_gone' not found" },
    });
  });

  it('POST / stores passthrough keys that are columns and drops the rest', async () => {
    const res = await app('articles:create').request(
      BASE,
      json({ name: 'Nested', parentId: 'afld_child', path: 'root/child/nested', level: 2, isPublic: false, metadata: { a: 1 } }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).toMatch(/^afld_/);
    expect(await row(data.id)).toMatchObject({
      name: 'Nested',
      parentId: 'afld_child',
      path: 'root/child/nested',
      level: 2,
      sortOrder: 0,
    });
  });

  it('POST / with a passthrough column of the wrong type is the route 500', async () => {
    const res = await app('articles:create').request(BASE, json({ name: 'Bad level', level: 'two' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create article folder' } });
  });

  it('PATCH /:id clears the parent with null and sets passthrough columns', async () => {
    const res = await app('articles:update').request(
      `${BASE}/afld_child`,
      json({ parentId: null, path: null, level: 0, sortOrder: 3 }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'afld_child' } });
    expect(await row('afld_child')).toMatchObject({ parentId: null, path: null, level: 0, sortOrder: 3, name: 'Child' });
  });

  it('PATCH /:id 404 when deleted, DELETE /:id 404 when missing', async () => {
    const { request } = app('articles:update', 'articles:delete');
    expect((await request(`${BASE}/afld_gone`, json({ name: 'Back' }, 'PATCH'))).status).toBe(404);
    const missing = await request(`${BASE}/nope_missing`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Article folder with ID 'nope_missing' not found" },
    });
  });
});

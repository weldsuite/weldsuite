/**
 * DB-backed integration tests for /api/categories.
 *
 * The route now derives a `slug` from `name` when none is provided,
 * resolving the previous Zod-vs-DB mismatch (slug is NOT NULL but
 * Zod marks it optional).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { categoriesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/categories · pglite integration', () => {
  it('POST / writes a category and derives slug from name', async () => {
    const { request } = createTestApp('/api/categories', categoriesRoutes, {
      context: { permissions: permissions('categories:create'), tenantDb: db },
    });

    const res = await request('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Welding Tools & Supplies' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^cat_/);

    const [row] = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Welding Tools & Supplies');
    expect(row?.slug).toBe('welding-tools-supplies');
  });

  it('POST / accepts an explicit slug verbatim', async () => {
    const { request } = createTestApp('/api/categories', categoriesRoutes, {
      context: { permissions: permissions('categories:create'), tenantDb: db },
    });

    const res = await request('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Anything', slug: 'custom-slug-here' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, body.data.id))
      .limit(1);
    expect(row?.slug).toBe('custom-slug-here');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/categories', categoriesRoutes, {
      context: { permissions: permissions('categories:create'), tenantDb: db },
    });
    const res = await request('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

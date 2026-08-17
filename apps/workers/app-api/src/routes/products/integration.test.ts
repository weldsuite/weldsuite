/**
 * DB-backed integration tests for /api/products.
 *
 * `products.slug` is NOT NULL with no default, so a create that doesn't carry
 * a slug through validation fails at the driver. The auth/validation tests in
 * `index.test.ts` never touch a database, which is why that gap went unseen.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { productsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/products · pglite integration', () => {
  it('POST / persists a product with its slug', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });

    const res = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Widget',
        slug: 'widget-abc123',
        price: 9.99,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, body.data.id))
      .limit(1);
    expect(row?.slug).toBe('widget-abc123');
    expect(row?.name).toBe('Widget');
  });

  it('POST / persists images and the featured image', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });

    const res = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Pictured',
        slug: 'pictured-1',
        featuredImageUrl: 'https://example.com/a.jpg',
        images: [
          { url: 'https://example.com/a.jpg', altText: 'Front' },
          { url: 'https://example.com/b.jpg' },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, body.data.id))
      .limit(1);
    expect(row?.featuredImageUrl).toBe('https://example.com/a.jpg');
    expect(row?.images).toHaveLength(2);
    expect(row?.images?.[0]?.altText).toBe('Front');
  });

  it('GET /:id/categories returns manual category membership', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create', 'products:read'), tenantDb: db },
    });

    const created = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Filed', slug: 'filed-1' }),
    });
    const { data: product } = (await created.json()) as { data: { id: string } };

    await db.insert(schema.categories).values([
      { id: 'cat_a', name: 'Tools', slug: 'tools', depth: 0, isActive: 1 },
      { id: 'cat_b', name: 'Anvils', slug: 'anvils', parentId: 'cat_a', depth: 1, isActive: 1 },
    ] as never);
    await db.insert(schema.categoryProducts).values([
      { id: 'cp_a', categoryId: 'cat_a', productId: product.id },
      { id: 'cp_b', categoryId: 'cat_b', productId: product.id },
    ]);

    const res = await request(`/api/products/${product.id}/categories`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
    // Ordered by name.
    expect(body.data.map((r) => r.name)).toEqual(['Anvils', 'Tools']);
  });

  it('GET / matches products by barcode', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create', 'products:read'), tenantDb: db },
    });

    const created = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Scanned Widget',
        slug: 'scanned-widget-1',
        sku: 'SKU-SCAN-1',
        barcode: '0123456789012',
      }),
    });
    expect(created.status).toBe(201);

    const res = await request('/api/products?search=0123456789012');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; barcode: string | null }> };
    expect(body.data.some((row) => row.barcode === '0123456789012')).toBe(true);
  });

  it('GET /:id/categories 404s for a missing product', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read'), tenantDb: db },
    });
    const res = await request('/api/products/prod_missing/categories');
    expect(res.status).toBe(404);
  });

  it('GET /:id/categories is gated on products:read', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });
    const res = await request('/api/products/prod_any/categories');
    expect(res.status).toBe(403);
  });
});

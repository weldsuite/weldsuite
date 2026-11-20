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
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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

  it('persists taxable and taxClass on create and returns them on reads', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create', 'products:read'), tenantDb: db },
    });

    const created = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hosted app', slug: 'hosted-app-tax-1', taxable: true, taxClass: 'saas' }),
    });
    expect(created.status).toBe(201);
    const { data: product } = (await created.json()) as { data: { id: string } };

    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, product.id)).limit(1);
    expect(row?.taxClass).toBe('saas');
    expect(row?.taxable).toBe(true);

    const one = await request(`/api/products/${product.id}`);
    const oneBody = (await one.json()) as { data: { taxable: boolean; taxClass: string } };
    expect(oneBody.data).toMatchObject({ taxable: true, taxClass: 'saas' });

    const listed = await request('/api/products?search=hosted-app-tax-1');
    const listBody = (await listed.json()) as {
      data: Array<{ id: string; taxable: boolean; taxClass: string }>;
    };
    expect(listBody.data.find((p) => p.id === product.id)).toMatchObject({ taxable: true, taxClass: 'saas' });
  });

  it('defaults to taxable with no tax class when the body carries neither', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });
    const created = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Untouched', slug: 'untouched-tax-1' }),
    });
    const { data: product } = (await created.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, product.id)).limit(1);
    expect(row?.taxable).toBe(true);
    expect(row?.taxClass).toBeNull();
  });

  it('accepts a Stripe and an Avalara provider code', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });
    for (const [slug, taxClass] of [
      ['stripe-code-tax-1', 'txcd_10302000'],
      ['avalara-code-tax-1', 'SW054000'],
    ] as const) {
      const res = await request('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, slug, taxClass }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };
      const [row] = await db.select().from(schema.products).where(eq(schema.products.id, data.id)).limit(1);
      expect(row?.taxClass).toBe(taxClass);
    }
  });

  it('refuses an unknown taxClass without creating the product', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create'), tenantDb: db },
    });
    const res = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad code', slug: 'bad-code-tax-1', taxClass: 'reduced' }),
    });
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.products).where(eq(schema.products.slug, 'bad-code-tax-1'));
    expect(rows).toHaveLength(0);
  });

  it('PATCH /:id changes, then clears, the tax fields and leaves them alone otherwise', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create', 'products:update'), tenantDb: db },
    });
    const created = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tee', slug: 'tee-tax-1', taxClass: 'clothing' }),
    });
    const { data: product } = (await created.json()) as { data: { id: string } };
    const load = async () =>
      (await db.select().from(schema.products).where(eq(schema.products.id, product.id)).limit(1))[0];
    const patch = (body: unknown) =>
      request(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await patch({ taxable: false, taxClass: 'non_taxable' })).status).toBe(200);
    expect(await load()).toMatchObject({ taxable: false, taxClass: 'non_taxable' });

    // A patch that names neither field keeps both.
    expect((await patch({ name: 'Tee shirt' })).status).toBe(200);
    expect(await load()).toMatchObject({ name: 'Tee shirt', taxable: false, taxClass: 'non_taxable' });

    expect((await patch({ taxClass: null })).status).toBe(200);
    expect((await load())?.taxClass).toBeNull();

    // A rejected code leaves the stored value as it was.
    expect((await patch({ taxClass: 'saas' })).status).toBe(200);
    expect((await patch({ taxClass: 'unknown-word' })).status).toBe(400);
    expect((await load())?.taxClass).toBe('saas');
  });

});

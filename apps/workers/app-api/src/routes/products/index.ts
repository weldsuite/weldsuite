/**
 * Product routes — flat /api/products/* surface backed by `products`.
 *
 * Permissions: products:read | products:create | products:update | products:delete.
 *
 * `GET /:id/categories` is the reverse of `GET /categories/:id/products`. It
 * reads the `category_products` junction, which carries a `product_id` index
 * for exactly this direction. Membership is written from the category side
 * (`POST|DELETE /categories/:id/products`), so there is no write here — one
 * owner for the junction keeps the manual/automated distinction in one place.
 *
 * Note this only reports MANUAL membership. An automated category's members
 * are computed from its rules at read time and never materialise as junction
 * rows, so a product can appear in an automated category without appearing
 * here. Surfacing that would mean evaluating every automated category's rules
 * per product, which is not worth it for a side panel.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createProductSchema, updateProductSchema } from '@weldsuite/core-api-client/schemas/products';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.products;

app.get('/', requirePermission('products:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.slug, term), like(t.sku, term), like(t.barcode, term))!);
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/products] list failed:', err);
    return error.internal(c, 'Failed to list products');
  }
});

app.get('/:id', requirePermission('products:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Product', id);
    const salesChannels = await db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.productId, id));
    return success(c, { ...row, salesChannels });
  } catch (err) {
    console.error('[app-api/products] get failed:', err);
    return error.internal(c, 'Failed to fetch product');
  }
});

/** Categories this product has been manually added to. */
app.get('/:id/categories', requirePermission('products:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [product] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!product) return error.notFound(c, 'Product', id);

    const rows = await db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        slug: schema.categories.slug,
        parentId: schema.categories.parentId,
        depth: schema.categories.depth,
        type: schema.categories.type,
        isActive: schema.categories.isActive,
      })
      .from(schema.categoryProducts)
      .innerJoin(schema.categories, eq(schema.categories.id, schema.categoryProducts.categoryId))
      .where(and(eq(schema.categoryProducts.productId, id), isNull(schema.categories.deletedAt)))
      .orderBy(schema.categories.name);

    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/products] list categories failed:', err);
    return error.internal(c, 'Failed to list product categories');
  }
});

app.get('/:id/sales-channels', requirePermission('products:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [product] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!product) return error.notFound(c, 'Product', id);
    const rows = await db
      .select()
      .from(schema.productSalesChannels)
      .where(eq(schema.productSalesChannels.productId, id));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/products] list sales channels failed:', err);
    return error.internal(c, 'Failed to list product sales channels');
  }
});

app.post('/', requirePermission('products:create'), zValidator('json', createProductSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('prod');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'product',
      entityId: id,
      action: 'created',
      data: { id, name: data.name ?? '', sku: data.sku, status: data.status, price: data.price, currency: data.currency },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/products] create failed:', err);
    return error.internal(c, 'Failed to create product');
  }
});

app.patch('/:id', requirePermission('products:update'), zValidator('json', updateProductSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Product', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'product',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name ?? '',
        sku: (update.sku as string | null | undefined) ?? existing.sku,
        status: (update.status as string | null | undefined) ?? existing.status,
        price: (update.price as string | null | undefined) ?? existing.price,
        currency: (update.currency as string | null | undefined) ?? existing.currency,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/products] update failed:', err);
    return error.internal(c, 'Failed to update product');
  }
});

app.delete('/:id', requirePermission('products:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Product', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'product',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name ?? '' },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/products] delete failed:', err);
    return error.internal(c, 'Failed to delete product');
  }
});

export const productsRoutes = app;

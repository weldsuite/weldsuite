import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createProductSchema,
  updateProductSchema,
} from '@weldsuite/core-api-client/schemas/products';

const listProductsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
});

const table = schema.products;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('products:read'), zValidator('query', listProductsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.name, term), like(table.slug, term), like(table.sku, term)));
  }
  if (q.status) where.push(eq(table.status, q.status));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('products:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Product', id);
  return success(c, row);
});

app.post('/', requireScope('products:write'), zValidator('json', createProductSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('prod');
  const [row] = await db
    .insert(table)
    .values({ id, createdAt: now, updatedAt: now, ...(body as Record<string, unknown>) } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create product');
  publishEntityEvent({
    c,
    entityType: 'product',
    entityId: id,
    action: 'created',
    data: { id, name: row.name ?? '', sku: row.sku, status: row.status, price: row.price, currency: row.currency },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('products:write'), zValidator('json', updateProductSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Product', id);
  publishEntityEvent({
    c,
    entityType: 'product',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name ?? '', sku: row.sku, status: row.status, price: row.price, currency: row.currency },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('products:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Product', id);
  publishEntityEvent({ c, entityType: 'product', entityId: id, action: 'deleted', data: { id, name: row.name ?? '' } });
  return noContent(c);
});

export default app;

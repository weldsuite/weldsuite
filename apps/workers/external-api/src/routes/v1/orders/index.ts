import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createOrderSchema,
  updateOrderSchema,
} from '@weldsuite/core-api-client/schemas/orders';

const listOrdersQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
});

const table = schema.orders;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('orders:read'), zValidator('query', listOrdersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.orderNumber, `%${q.search}%`));
  if (q.customerId) where.push(eq(table.customerId, q.customerId));
  if (q.status) where.push(eq(table.status, q.status));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Order', id);
  return success(c, row);
});

app.post('/', requireScope('orders:write'), zValidator('json', createOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('ord');
  // orderNumber is NOT NULL with no DB default — generate when absent.
  const orderNumber =
    (body.orderNumber as string | undefined) ??
    `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const [row] = await db
    .insert(table)
    .values({ id, createdAt: now, updatedAt: now, ...body, orderNumber } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create order');
  publishEntityEvent({
    c,
    entityType: 'commerce_order',
    entityId: id,
    action: 'created',
    data: {
      id,
      orderNumber: row.orderNumber,
      status: row.status,
      total: row.total,
      currency: row.currency,
      customerId: row.customerId,
      customerEmail: row.customerEmail,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('orders:write'), zValidator('json', updateOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Order', id);
  publishEntityEvent({
    c,
    entityType: 'commerce_order',
    entityId: id,
    action: 'updated',
    data: {
      id,
      orderNumber: row.orderNumber,
      status: row.status,
      total: row.total,
      currency: row.currency,
      customerId: row.customerId,
      customerEmail: row.customerEmail,
    },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('orders:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Order', id);
  publishEntityEvent({
    c,
    entityType: 'commerce_order',
    entityId: id,
    action: 'deleted',
    data: { id, orderNumber: row.orderNumber },
  });
  return noContent(c);
});

export default app;

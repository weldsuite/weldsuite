/**
 * Ticket message routes — flat /api/ticket-messages/* surface backed by `helpdeskTicketMessages`.
 *
 * Permissions: tickets:read | tickets:create | tickets:update | tickets:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTicketMessageSchema, updateTicketMessageSchema } from '@weldsuite/core-api-client/schemas/ticket-messages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskTicketMessages;

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.ticketId !== undefined && q.ticketId !== '') conditions.push(eq(t.ticketId, q.ticketId));
  if (q.authorId !== undefined && q.authorId !== '') conditions.push(eq(t.authorId, q.authorId));
  if (q.search) {
    conditions.push(like(t.subject, `%${q.search}%`));
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
    console.error('[app-api/ticket-messages] list failed:', err);
    return error.internal(c, 'Failed to list ticket messages');
  }
});

app.get('/:id', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Ticket message', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/ticket-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch ticket message');
  }
});

app.post('/', requirePermission('tickets:create'), zValidator('json', createTicketMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('tmsg');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'helpdesk_message', entityId: id, action: 'created', data: { id, ticketId: (data as Record<string, unknown>).ticketId, authorId: (data as Record<string, unknown>).authorId, subject: (data as Record<string, unknown>).subject } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/ticket-messages] create failed:', err);
    return error.internal(c, 'Failed to create ticket message');
  }
});

app.patch('/:id', requirePermission('tickets:update'), zValidator('json', updateTicketMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket message', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'helpdesk_message', entityId: id, action: 'updated', data: { id, ticketId: existing.ticketId, authorId: existing.authorId, subject: (update.subject as string | undefined) ?? existing.subject } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/ticket-messages] update failed:', err);
    return error.internal(c, 'Failed to update ticket message');
  }
});

app.delete('/:id', requirePermission('tickets:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket message', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'helpdesk_message', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/ticket-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete ticket message');
  }
});

export const ticketMessagesRoutes = app;

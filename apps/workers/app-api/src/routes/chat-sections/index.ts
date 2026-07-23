/**
 * Chat section routes — flat /api/chat-sections/* surface backed by `chatSections`.
 *
 * Permissions: channels:read | channels:create | channels:update | channels:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createChatSectionSchema, updateChatSectionSchema } from '@weldsuite/core-api-client/schemas/chat-sections';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatSections;

app.get('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
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
    console.error('[app-api/chat-sections] list failed:', err);
    return error.internal(c, 'Failed to list chat sections');
  }
});

app.get('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Chat section', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/chat-sections] get failed:', err);
    return error.internal(c, 'Failed to fetch chat section');
  }
});

app.post('/', requirePermission('channels:create'), zValidator('json', createChatSectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('csec');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/chat-sections] create failed:', err);
    return error.internal(c, 'Failed to create chat section');
  }
});

app.patch('/:id', requirePermission('channels:update'), zValidator('json', updateChatSectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Chat section', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/chat-sections] update failed:', err);
    return error.internal(c, 'Failed to update chat section');
  }
});

app.delete('/:id', requirePermission('channels:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Chat section', id);
    await db.delete(t).where(eq(t.id, id));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-sections] delete failed:', err);
    return error.internal(c, 'Failed to delete chat section');
  }
});

export const chatSectionsRoutes = app;

/**
 * Category routes — flat /api/categories/* surface backed by `categories`.
 *
 * Permissions: categories:read | categories:create | categories:update | categories:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createCategorySchema, updateCategorySchema } from '@weldsuite/core-api-client/schemas/categories';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.categories;

app.get('/', requirePermission('categories:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.parentId !== undefined && q.parentId !== '') conditions.push(eq(t.parentId, q.parentId));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.slug, term))!);
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
    console.error('[app-api/categories] list failed:', err);
    return error.internal(c, 'Failed to list categorys');
  }
});

app.get('/:id', requirePermission('categories:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Category', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/categories] get failed:', err);
    return error.internal(c, 'Failed to fetch category');
  }
});

app.post('/', requirePermission('categories:create'), zValidator('json', createCategorySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('cat');
  const now = new Date();
  // `slug` is NOT NULL at the DB layer but optional in Zod. Derive
  // one from `name` (lowercase, non-alphanumerics → '-') so callers
  // can omit it. Falls back to the id if name is somehow missing.
  const slug =
    typeof data.slug === 'string' && data.slug.length > 0
      ? data.slug
      : typeof data.name === 'string'
        ? data.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 255) || id
        : id;
  try {
    await db
      .insert(t)
      .values({ id, ...data, slug, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'created',
      data: { id, name: data.name as string, slug, parentId: data.parentId as string | undefined },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/categories] create failed:', err);
    return error.internal(c, 'Failed to create category');
  }
});

app.patch('/:id', requirePermission('categories:update'), zValidator('json', updateCategorySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Category', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        slug: (update.slug as string | undefined) ?? existing.slug,
        parentId: (update.parentId as string | null | undefined) ?? existing.parentId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/categories] update failed:', err);
    return error.internal(c, 'Failed to update category');
  }
});

app.delete('/:id', requirePermission('categories:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Category', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/categories] delete failed:', err);
    return error.internal(c, 'Failed to delete category');
  }
});

export const categoriesRoutes = app;

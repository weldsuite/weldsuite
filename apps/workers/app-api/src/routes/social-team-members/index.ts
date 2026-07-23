/**
 * Social team member routes — flat /api/social-team-members/* surface backed by `socialTeamMembers`.
 *
 * Permissions: posts:read | posts:create | posts:update | posts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createSocialTeamMemberSchema, updateSocialTeamMemberSchema } from '@weldsuite/core-api-client/schemas/social-team-members';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.socialTeamMembers;

app.get('/', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.userId !== undefined && q.userId !== '') conditions.push(eq(t.userId, q.userId));
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
    console.error('[app-api/social-team-members] list failed:', err);
    return error.internal(c, 'Failed to list social team members');
  }
});

app.get('/:id', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Social team member', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/social-team-members] get failed:', err);
    return error.internal(c, 'Failed to fetch social team member');
  }
});

app.post('/', requirePermission('posts:create'), zValidator('json', createSocialTeamMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('stm');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'social_team_member',
      entityId: id,
      action: 'added',
      data: { id, userId: data.userId, role: data.role ?? 'contributor' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/social-team-members] create failed:', err);
    return error.internal(c, 'Failed to create social team member');
  }
});

app.patch('/:id', requirePermission('posts:update'), zValidator('json', updateSocialTeamMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social team member', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'social_team_member',
      entityId: id,
      action: 'updated',
      data: {
        id,
        userId: existing.userId,
        role: ((update.role as string | undefined) ?? existing.role) || 'contributor',
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/social-team-members] update failed:', err);
    return error.internal(c, 'Failed to update social team member');
  }
});

app.delete('/:id', requirePermission('posts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social team member', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'social_team_member',
      entityId: id,
      action: 'removed',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/social-team-members] delete failed:', err);
    return error.internal(c, 'Failed to delete social team member');
  }
});

export const socialTeamMembersRoutes = app;

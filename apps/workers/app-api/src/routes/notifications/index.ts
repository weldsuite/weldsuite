/**
 * Notification routes — flat /api/notifications/* surface backed by `notifications`.
 *
 * Permissions: reads and self-scoped personal actions (mark-read, delete own
 * notification) use general:read — the baseline every role holds. Creating
 * notifications requires general:create; PATCH (generic update) general:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createNotificationSchema, updateNotificationSchema } from '@weldsuite/core-api-client/schemas/notifications';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.notifications;

app.get('/', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  // Notifications are personal: a user must never read another user's
  // notifications. Always scope to the authenticated user, ignoring any
  // `?userId=` filter (which previously allowed cross-user reads).
  const conditions: any[] = [eq(t.userId, c.get('userId')), isNull(t.deletedAt)];
  if (q.isRead !== undefined && q.isRead !== '') conditions.push(eq(t.isRead, q.isRead as never));
  // Snapshot the filter set BEFORE the cursor predicate is (conditionally)
  // pushed — a stale cursor id finds no row and pushes nothing, so slicing
  // the last element off afterwards would drop a real filter instead.
  const filterConditions = [...conditions];
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

    // Enrich user-actor notifications with the actor's avatar + name so clients
    // can show who triggered the notification (e.g. who mentioned you).
    const actorIds = Array.from(
      new Set(
        data
          .filter((r) => r.actorType === 'user' && r.actorId)
          .map((r) => r.actorId as string),
      ),
    );
    let actorMap = new Map<string, { name: string | null; picture: string | null }>();
    if (actorIds.length > 0) {
      const m = schema.workspaceMembers;
      const members = await db
        .select({ userId: m.userId, name: m.name, picture: m.picture })
        .from(m)
        .where(inArray(m.userId, actorIds));
      actorMap = new Map(members.map((mem) => [mem.userId, { name: mem.name, picture: mem.picture }]));
    }
    const enriched = data.map((r) => {
      const actor = r.actorType === 'user' && r.actorId ? actorMap.get(r.actorId) : undefined;
      return { ...r, actorName: actor?.name ?? null, actorAvatar: actor?.picture ?? null };
    });

    return list(c, enriched, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/notifications] list failed:', err);
    return error.internal(c, 'Failed to list notifications');
  }
});

// Literal segments must be registered before the `/:id` param route so the
// router matches them first.
app.get('/unread-count', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const [res] = await db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.isRead, false), isNull(t.deletedAt)));
    return success(c, { count: Number(res?.count ?? 0) });
  } catch (err) {
    console.error('[app-api/notifications] unread-count failed:', err);
    return error.internal(c, 'Failed to count unread notifications');
  }
});

// Notifications are personal resources: mark-read / delete act only on the
// authenticated user's own rows (self-scoped below), so they are gated on
// general:read — the baseline every workspace role holds — not the admin-level
// general:update/delete (legacy core-api had no gate at all; requiring admin
// permissions here broke the bell for MEMBER/VIEWER roles).
app.post('/read-all', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const rows = await db
      .update(t)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(t.userId, userId), eq(t.isRead, false), isNull(t.deletedAt)))
      .returning({ id: t.id });
    return success(c, { updated: rows.length });
  } catch (err) {
    console.error('[app-api/notifications] read-all failed:', err);
    return error.internal(c, 'Failed to mark notifications as read');
  }
});

app.post('/:id/read', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Notification', id);

    const [row] = await db
      .update(t)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'notification',
      action: 'updated',
      entityId: id,
      data: {
        id: row.id,
        title: row.title,
        body: row.body,
        category: row.category,
        actionUrl: row.actionUrl,
        entityType: row.entityType,
        entityId: row.entityId,
      },
    });

    return success(c, row);
  } catch (err) {
    console.error('[app-api/notifications] mark read failed:', err);
    return error.internal(c, 'Failed to mark notification as read');
  }
});

app.get('/:id', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    // Self-scope: a user must never read another user's notification.
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, c.get('userId'))))
      .limit(1);
    if (!row) return error.notFound(c, 'Notification', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/notifications] get failed:', err);
    return error.internal(c, 'Failed to fetch notification');
  }
});

app.post('/', requirePermission('general:create'), zValidator('json', createNotificationSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('ntf');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/notifications] create failed:', err);
    return error.internal(c, 'Failed to create notification');
  }
});

app.patch('/:id', requirePermission('general:update'), zValidator('json', updateNotificationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    // Self-scope: notifications are personal — never mutate another user's row.
    const scope = and(eq(t.id, id), eq(t.userId, userId));
    const [existing] = await db.select().from(t).where(scope).limit(1);
    if (!existing) return error.notFound(c, 'Notification', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(scope);
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/notifications] update failed:', err);
    return error.internal(c, 'Failed to update notification');
  }
});

app.delete('/:id', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    // Self-scoped soft delete (matches legacy core-api semantics: rows keep
    // their audit trail and stay excluded from list/unread-count via deletedAt).
    const scope = and(eq(t.id, id), eq(t.userId, userId), isNull(t.deletedAt));
    const [existing] = await db.select().from(t).where(scope).limit(1);
    if (!existing) return error.notFound(c, 'Notification', id);
    await db.update(t).set({ deletedAt: new Date() }).where(scope);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/notifications] delete failed:', err);
    return error.internal(c, 'Failed to delete notification');
  }
});

export const notificationsRoutes = app;

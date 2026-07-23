/**
 * Notification preference routes — flat /api/notification-preferences/* surface backed by `notificationPreferences`.
 *
 * Permissions: preferences are a personal, self-scoped resource — every route
 * below force-scopes to `c.get('userId')`. The writes the settings UI actually
 * calls (`PUT /`, `PUT /module/:module`) are therefore gated on general:read,
 * the baseline tier every workspace role holds, matching the sibling
 * /api/notifications routes. Legacy api-worker gated these on nothing at all
 * beyond auth, so requiring general:update here would 403 a MEMBER out of their
 * own notification settings page.
 *
 * The generic per-row POST/PATCH/DELETE keep their create/update/delete tiers
 * (no UI reaches them; they are the object-CRUD shell).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  moduleChannelPreferencesSchema,
  moduleNameSchema,
  mergeModulePreferences,
  upsertNotificationPreferences,
  upsertNotificationPreferencesSchema,
} from '../../services/notification-preferences';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.notificationPreferences;

app.get('/', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  // Preferences are personal: always scope to the authenticated user and
  // ignore any `?userId=` filter (which previously allowed cross-user reads).
  const conditions: any[] = [eq(t.userId, c.get('userId'))];
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
    console.error('[app-api/notification-preferences] list failed:', err);
    return error.internal(c, 'Failed to list notification preferences');
  }
});

app.get('/:id', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    // Self-scope: a user must never read another user's preference.
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, c.get('userId'))))
      .limit(1);
    if (!row) return error.notFound(c, 'Notification preference', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/notification-preferences] get failed:', err);
    return error.internal(c, 'Failed to fetch notification preference');
  }
});

/**
 * PUT / — upsert the caller's preferences (partial).
 *
 * This is the endpoint the notification settings page writes through, and the
 * only way to create a user's FIRST preference row: the table is a singleton
 * per user, so the client has no id to PATCH and nothing to POST against.
 *
 * Partial by design — the UI toggles one switch and sends one key. Omitted keys
 * are left untouched on an existing row.
 *
 * Legacy `PUT /settings/notification-preferences/global` is not ported: it was
 * this same upsert narrowed to `{ doNotDisturb, soundEnabled }`, both of which
 * this route already accepts. One upsert, no alias.
 */
app.put('/', requirePermission('general:read'), zValidator('json', upsertNotificationPreferencesSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const row = await upsertNotificationPreferences(db, c.get('userId'), data);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/notification-preferences] upsert failed:', err);
    return error.internal(c, 'Failed to update notification preferences');
  }
});

/**
 * PUT /module/:module — merge one module's channel prefs into the JSONB.
 *
 * The merge is server-side (see the service): toggling Helpdesk must not drop
 * the user's CRM settings.
 *
 * No `PUT /:id` exists, so the literal `/module/` prefix cannot be shadowed by
 * a param route; if one is ever added, it must be registered after this.
 */
app.put('/module/:module', requirePermission('general:read'), zValidator('json', moduleChannelPreferencesSchema), async (c) => {
  const db = c.get('tenantDb');
  const prefs = c.req.valid('json');
  const moduleName = moduleNameSchema.safeParse(c.req.param('module'));
  if (!moduleName.success) return error.badRequest(c, 'Invalid module name');
  try {
    const row = await mergeModulePreferences(db, c.get('userId'), moduleName.data, prefs);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/notification-preferences] module merge failed:', err);
    return error.internal(c, 'Failed to update module preferences');
  }
});

app.post('/', requirePermission('general:create'), zValidator('json', upsertNotificationPreferencesSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('npr');
  const now = new Date();
  try {
    // Preferences are personal: force ownership to the authenticated user so a
    // caller can never create a preference targeting another user.
    await db.insert(t).values({
      ...data,
      id,
      userId: c.get('userId'),
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/notification-preferences] create failed:', err);
    return error.internal(c, 'Failed to create notification preference');
  }
});

app.patch('/:id', requirePermission('general:update'), zValidator('json', upsertNotificationPreferencesSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  const userId = c.get('userId');
  try {
    // Self-scope: a user may only update their own preference.
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Notification preference', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    // Never let the update reassign ownership to another user.
    delete update.userId;
    await db.update(t).set(update).where(and(eq(t.id, id), eq(t.userId, userId)));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/notification-preferences] update failed:', err);
    return error.internal(c, 'Failed to update notification preference');
  }
});

app.delete('/:id', requirePermission('general:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    // Self-scope: a user may only delete their own preference.
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Notification preference', id);
    await db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId)));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/notification-preferences] delete failed:', err);
    return error.internal(c, 'Failed to delete notification preference');
  }
});

export const notificationPreferencesRoutes = app;

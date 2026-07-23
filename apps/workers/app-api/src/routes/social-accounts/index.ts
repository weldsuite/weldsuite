/**
 * Social account routes — flat /api/social-accounts/* surface backed by `socialAccounts`.
 *
 * Permissions: posts:read | posts:create | posts:update | posts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { z } from 'zod';
import { createSocialAccountSchema, updateSocialAccountSchema } from '@weldsuite/core-api-client/schemas/social-accounts';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  getConnectUrl,
  syncAccounts,
  PostPeerNotConfiguredError,
} from '../../services/social-publishing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.socialAccounts;

const connectSchema = z.object({
  platform: z.enum(['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok']),
  redirectUri: z.string().url().optional(),
});

app.get('/', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.platform !== undefined && q.platform !== '') conditions.push(eq(t.platform, q.platform as never));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status as never));
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
    // Never expose the raw OAuth tokens to `posts:read` holders.
    const safe = data.map((r) => ({ ...r, accessToken: undefined, refreshToken: undefined }));
    return list(c, safe, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/social-accounts] list failed:', err);
    return error.internal(c, 'Failed to list social accounts');
  }
});

/**
 * POST /connect — start the PostPeer hosted OAuth flow for a platform.
 * Returns a URL the user opens to authorize. The connected channel lands under
 * the workspace's PostPeer profile; call POST /sync afterwards to import it.
 */
app.post('/connect', requirePermission('posts:update'), zValidator('json', connectSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const { platform, redirectUri } = c.req.valid('json');
  try {
    const result = await getConnectUrl(db, c.env, workspaceId, platform, redirectUri);
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    console.error('[app-api/social-accounts] connect failed:', err);
    return error.internal(c, 'Failed to start account connection');
  }
});

/**
 * POST /sync — import the workspace's PostPeer-connected channels into
 * socialAccounts (upsert by postpeerIntegrationId).
 */
app.post('/sync', requirePermission('posts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  try {
    const result = await syncAccounts(db, c.env, workspaceId, userId);
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    console.error('[app-api/social-accounts] sync failed:', err);
    return error.internal(c, 'Failed to sync social accounts');
  }
});

app.get('/:id', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Social account', id);
    return success(c, { ...row, accessToken: undefined, refreshToken: undefined });
  } catch (err) {
    console.error('[app-api/social-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch social account');
  }
});

app.post('/', requirePermission('posts:create'), zValidator('json', createSocialAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const raw = c.req.valid('json') as Record<string, any>;
  // connectedByUserId is NOT NULL and server-owned — default it from auth.
  const data: Record<string, any> = { ...raw, connectedByUserId: raw.connectedByUserId ?? userId };
  const id = generateId('sac');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'social_account',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, platform: data.platform, status: data.status ?? 'active' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/social-accounts] create failed:', err);
    return error.internal(c, 'Failed to create social account');
  }
});

app.patch('/:id', requirePermission('posts:update'), zValidator('json', updateSocialAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social account', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'social_account',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        platform: existing.platform,
        status: ((update.status as string | undefined) ?? existing.status) || 'active',
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/social-accounts] update failed:', err);
    return error.internal(c, 'Failed to update social account');
  }
});

app.delete('/:id', requirePermission('posts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social account', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'social_account',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/social-accounts] delete failed:', err);
    return error.internal(c, 'Failed to delete social account');
  }
});

export const socialAccountsRoutes = app;

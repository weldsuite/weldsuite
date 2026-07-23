/**
 * Social post routes — flat /api/social-posts/* surface backed by `socialPosts`.
 *
 * Permissions: posts:read | posts:create | posts:update | posts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { z } from 'zod';
import { createSocialPostSchema, updateSocialPostSchema } from '@weldsuite/core-api-client/schemas/social-posts';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  publishPost,
  cancelPost,
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
} from '../../services/social-publishing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.socialPosts;

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  timezone: z.string().optional(),
});

app.get('/', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status as never));
  if (q.campaignId !== undefined && q.campaignId !== '') conditions.push(eq(t.campaignId, q.campaignId));
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
    console.error('[app-api/social-posts] list failed:', err);
    return error.internal(c, 'Failed to list social posts');
  }
});

app.get('/:id', requirePermission('posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Social post', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/social-posts] get failed:', err);
    return error.internal(c, 'Failed to fetch social post');
  }
});

app.post('/', requirePermission('posts:create'), zValidator('json', createSocialPostSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { accountIds, ...rest } = c.req.valid('json') as Record<string, any>;
  // Server-owned + NOT NULL columns: createdByUserId from auth; content/target
  // default so drafts can be saved before a channel/copy is chosen.
  const data: Record<string, any> = {
    ...rest,
    content: rest.content ?? '',
    targetAccountIds: rest.targetAccountIds ?? accountIds ?? [],
    createdByUserId: rest.createdByUserId ?? userId,
  };
  const id = generateId('spo');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'created',
      data: { id, title: data.title, status: data.status ?? 'draft', campaignId: data.campaignId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/social-posts] create failed:', err);
    return error.internal(c, 'Failed to create social post');
  }
});

/**
 * POST /:id/publish — publish a post immediately via PostPeer.
 */
app.post('/:id/publish', requirePermission('posts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  try {
    const result = await publishPost(db, c.env, workspaceId, id, { now: true });
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: result.status === 'failed' ? 'failed' : 'published',
      data: { id, status: result.status, postpeerPostId: result.postpeerPostId },
    });
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    if (err instanceof SocialInsufficientCreditsError) {
      return error.insufficientCredits(c, {
        currentBalance: err.currentBalance,
        required: err.required,
        shortfall: err.required - err.currentBalance,
      });
    }
    console.error('[app-api/social-posts] publish failed:', err);
    return error.internal(c, err instanceof Error ? err.message : 'Failed to publish post');
  }
});

/**
 * POST /:id/schedule — schedule a post for a future time via PostPeer.
 */
app.post('/:id/schedule', requirePermission('posts:update'), zValidator('json', scheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const { scheduledAt, timezone } = c.req.valid('json');
  try {
    // publishPost persists scheduledAt/timezone atomically as part of claiming
    // the publishing slot, so the stored time always matches what is submitted
    // to PostPeer even under concurrent requests.
    const result = await publishPost(db, c.env, workspaceId, id, { now: false, scheduledAt, timezone });
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'scheduled',
      data: { id, status: result.status, scheduledAt, postpeerPostId: result.postpeerPostId },
    });
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    if (err instanceof SocialInsufficientCreditsError) {
      return error.insufficientCredits(c, {
        currentBalance: err.currentBalance,
        required: err.required,
        shortfall: err.required - err.currentBalance,
      });
    }
    console.error('[app-api/social-posts] schedule failed:', err);
    return error.internal(c, err instanceof Error ? err.message : 'Failed to schedule post');
  }
});

/**
 * POST /:id/reschedule — move a scheduled post to a new time. Re-submits to
 * PostPeer with the new time (creating a fresh PostPeer post) and updates the row.
 */
app.post('/:id/reschedule', requirePermission('posts:update'), zValidator('json', scheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const { scheduledAt, timezone } = c.req.valid('json');
  try {
    // scheduledAt/timezone are persisted atomically inside publishPost (with the
    // publishing-slot claim), so a concurrent reschedule can't desync the stored
    // time from the time submitted to PostPeer.
    const result = await publishPost(db, c.env, workspaceId, id, { now: false, scheduledAt, timezone });
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'scheduled',
      data: { id, status: result.status, scheduledAt, postpeerPostId: result.postpeerPostId },
    });
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    if (err instanceof SocialInsufficientCreditsError) {
      return error.insufficientCredits(c, {
        currentBalance: err.currentBalance,
        required: err.required,
        shortfall: err.required - err.currentBalance,
      });
    }
    console.error('[app-api/social-posts] reschedule failed:', err);
    return error.internal(c, err instanceof Error ? err.message : 'Failed to reschedule post');
  }
});

/**
 * POST /:id/cancel — cancel a scheduled/draft post (marks it cancelled locally).
 */
app.post('/:id/cancel', requirePermission('posts:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  try {
    // cancelPost also cancels the live PostPeer scheduled post (if any) so it
    // can't still fire after the user cancels, and refunds the charged credits.
    const cancelled = await cancelPost(db, c.env, workspaceId, id);
    if (!cancelled) return error.notFound(c, 'Social post', id);
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'cancelled',
      data: { id, status: 'cancelled' },
    });
    return success(c, { id, status: 'cancelled' });
  } catch (err) {
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    console.error('[app-api/social-posts] cancel failed:', err);
    return error.internal(c, 'Failed to cancel post');
  }
});

app.patch('/:id', requirePermission('posts:update'), zValidator('json', updateSocialPostSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social post', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: (update.title as string | null | undefined) ?? existing.title,
        status: ((update.status as string | undefined) ?? existing.status) || 'draft',
        campaignId: (update.campaignId as string | null | undefined) ?? existing.campaignId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/social-posts] update failed:', err);
    return error.internal(c, 'Failed to update social post');
  }
});

app.delete('/:id', requirePermission('posts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social post', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/social-posts] delete failed:', err);
    return error.internal(c, 'Failed to delete social post');
  }
});

export const socialPostsRoutes = app;

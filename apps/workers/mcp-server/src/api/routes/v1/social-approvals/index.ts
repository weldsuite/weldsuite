/**
 * Social approval routes — flat /api/social-approvals/* surface backed by `socialApprovals`.
 *
 * Permissions: posts:read | posts:create | posts:update | posts:delete.
 *
 * Approve path: marking an approval as approved also marks the post approved and,
 * when `scheduledAt` is set, immediately registers delivery with PostPeer so the
 * human does not need a second "Schedule" click.
 */

import { Hono } from 'hono';
import { requireScope } from '../../../lib/scopes';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  publishPost,
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
} from '@weldsuite/social-publishing';
import { createSocialApprovalSchema, updateSocialApprovalSchema } from '@weldsuite/core-api-client/schemas/social-approvals';
import type { HonoEnv } from '../../../types';
import { cursorPagination, error, list, noContent, success } from '../../../lib/response';
import { generateId } from '../../../lib/id';
import { schema } from '../../../db';
import { socialContext, resolveClerkOrgId } from '../../../lib/social-context';

const app = new Hono<HonoEnv>();
const t = schema.socialApprovals;
const posts = schema.socialPosts;

const decideSchema = z.object({
  decisionNotes: z.string().optional(),
  rejectionReason: z.string().optional(),
});

app.get('/', requireScope('social_posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.postId !== undefined && q.postId !== '') conditions.push(eq(t.postId, q.postId));
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
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[mcp-server/social-approvals] list failed:', err);
    return error.internal(c, 'Failed to list social approvals');
  }
});

app.get('/:id', requireScope('social_posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Social approval', id);
    return success(c, row);
  } catch (err) {
    console.error('[mcp-server/social-approvals] get failed:', err);
    return error.internal(c, 'Failed to fetch social approval');
  }
});

app.post('/', requireScope('social_posts:write'), zValidator('json', createSocialApprovalSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const userId = c.get('userId') ?? 'system';
  const id = generateId('sap');
  const now = new Date();
  const postId = typeof data.postId === 'string' ? data.postId : null;
  if (!postId) return error.badRequest(c, 'postId is required');

  try {
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), isNull(posts.deletedAt)))
      .limit(1);
    if (!post) return error.notFound(c, 'Social post', postId);

    await db.insert(t).values({
      id,
      postId,
      version: typeof data.version === 'number' ? data.version : 1,
      status: 'pending',
      submittedByUserId: data.submittedByUserId || userId,
      submittedAt: data.submittedAt ? new Date(data.submittedAt) : now,
      submissionNotes: data.submissionNotes ?? data.comment ?? null,
      assignedToUserId: data.assignedToUserId ?? data.approverId ?? null,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);

    // Move the post into the approval queue (keeps intended scheduledAt intact).
    await db
      .update(posts)
      .set({
        status: 'pending_approval',
        approvalRequestedAt: now,
        updatedAt: now,
      })
      .where(and(eq(posts.id, postId), isNull(posts.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'social_approval',
      entityId: id,
      action: 'created',
      data: { id, postId, status: 'pending', submittedByUserId: data.submittedByUserId || userId },
    });
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: postId,
      action: 'updated',
      data: { id: postId, status: 'pending_approval' },
    });
    return success(c, { id, postId }, 201);
  } catch (err) {
    console.error('[mcp-server/social-approvals] create failed:', err);
    return error.internal(c, 'Failed to create social approval');
  }
});

/**
 * POST /:id/approve — approve the pending request and auto-schedule when the
 * post already has an intended `scheduledAt`.
 */
app.post('/:id/approve', requireScope('social_posts:write'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId') ?? 'system';
  const id = c.req.param('id');
  let decisionNotes: string | undefined;
  try {
    const raw = await c.req.json().catch(() => ({}));
    if (raw && typeof raw === 'object' && typeof (raw as { decisionNotes?: unknown }).decisionNotes === 'string') {
      decisionNotes = (raw as { decisionNotes: string }).decisionNotes;
    }
  } catch {
    // empty body is fine
  }

  try {
    const [approval] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!approval) return error.notFound(c, 'Social approval', id);
    if (approval.status !== 'pending') {
      return error.conflict(c, 'Approval is not pending');
    }

    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, approval.postId), isNull(posts.deletedAt)))
      .limit(1);
    if (!post) return error.notFound(c, 'Social post', approval.postId);

    const now = new Date();
    await db
      .update(t)
      .set({
        status: 'approved',
        decidedByUserId: userId,
        decidedAt: now,
        decisionNotes: decisionNotes ?? null,
        updatedAt: now,
      })
      .where(eq(t.id, id));

    await db
      .update(posts)
      .set({
        status: 'approved',
        approvedAt: now,
        approvedByUserId: userId,
        updatedAt: now,
      })
      .where(eq(posts.id, post.id));

    let scheduled = false;
    let scheduleError: string | null = null;
    let publishResult: Awaited<ReturnType<typeof publishPost>> | null = null;

    if (post.scheduledAt) {
      try {
        const scheduledAt =
          post.scheduledAt instanceof Date
            ? post.scheduledAt.toISOString()
            : new Date(post.scheduledAt).toISOString();
        const orgId = await resolveClerkOrgId(c.env, workspaceId);
        if (!orgId) {
          throw new Error('Workspace is not linked to an organization');
        }
        publishResult = await publishPost(db, socialContext(c.env), orgId, post.id, {
          now: false,
          scheduledAt,
          timezone: post.timezone ?? undefined,
        });
        scheduled = true;
        publishEntityEvent({
          c,
          entityType: 'social_post',
          entityId: post.id,
          action: 'scheduled',
          data: {
            id: post.id,
            status: publishResult.status,
            scheduledAt,
            postpeerPostId: publishResult.postpeerPostId,
          },
        });
      } catch (err) {
        // Approval still succeeds — scheduling can be retried from the queue/composer.
        scheduleError =
          err instanceof Error ? err.message : 'Failed to auto-schedule after approval';
        console.error('[mcp-server/social-approvals] auto-schedule after approve failed:', err);
        if (err instanceof PostPeerNotConfiguredError) {
          scheduleError = 'Social publishing is not configured';
        } else if (err instanceof SocialPublishConflictError) {
          scheduleError = err.message;
        } else if (err instanceof SocialInsufficientCreditsError) {
          scheduleError = `Insufficient credits (need ${err.required}, have ${err.currentBalance})`;
        }
      }
    }

    publishEntityEvent({
      c,
      entityType: 'social_approval',
      entityId: id,
      action: 'updated',
      data: { id, postId: post.id, status: 'approved' },
    });

    return success(c, {
      approvalId: id,
      postId: post.id,
      status: 'approved',
      scheduled,
      scheduleError,
      publishResult,
    });
  } catch (err) {
    console.error('[mcp-server/social-approvals] approve failed:', err);
    return error.internal(c, 'Failed to approve social post');
  }
});

/**
 * POST /:id/reject — reject (or request revision) and bounce the post to draft.
 */
app.post('/:id/reject', requireScope('social_posts:write'), zValidator('json', decideSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId') ?? 'system';
  const id = c.req.param('id');
  const body = c.req.valid('json') as { decisionNotes?: string; rejectionReason?: string };
  const asRevision = c.req.query('revision') === '1' || c.req.query('revision') === 'true';

  try {
    const [approval] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!approval) return error.notFound(c, 'Social approval', id);
    if (approval.status !== 'pending') {
      return error.conflict(c, 'Approval is not pending');
    }

    const now = new Date();
    const nextStatus = asRevision ? 'revision_requested' : 'rejected';
    await db
      .update(t)
      .set({
        status: nextStatus,
        decidedByUserId: userId,
        decidedAt: now,
        decisionNotes: body.decisionNotes ?? null,
        rejectionReason: body.rejectionReason ?? body.decisionNotes ?? null,
        updatedAt: now,
      })
      .where(eq(t.id, id));

    await db
      .update(posts)
      .set({
        status: 'draft',
        rejectedAt: asRevision ? null : now,
        rejectedByUserId: asRevision ? null : userId,
        rejectionReason: body.rejectionReason ?? body.decisionNotes ?? null,
        updatedAt: now,
      })
      .where(and(eq(posts.id, approval.postId), isNull(posts.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'social_approval',
      entityId: id,
      action: 'updated',
      data: { id, postId: approval.postId, status: nextStatus },
    });
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: approval.postId,
      action: 'updated',
      data: { id: approval.postId, status: 'draft' },
    });

    return success(c, { approvalId: id, postId: approval.postId, status: nextStatus });
  } catch (err) {
    console.error('[mcp-server/social-approvals] reject failed:', err);
    return error.internal(c, 'Failed to reject social approval');
  }
});

app.patch('/:id', requireScope('social_posts:write'), zValidator('json', updateSocialApprovalSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social approval', id);

    // Route status transitions that need side effects through the action endpoints.
    if (data.status === 'approved' && existing.status === 'pending') {
      return error.badRequest(c, 'Use POST /social-approvals/:id/approve to approve (auto-schedules when scheduledAt is set)');
    }
    if (
      (data.status === 'rejected' || data.status === 'revision_requested') &&
      existing.status === 'pending'
    ) {
      return error.badRequest(c, 'Use POST /social-approvals/:id/reject to reject or request revision');
    }

    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'social_approval',
      entityId: id,
      action: 'updated',
      data: {
        id,
        postId: existing.postId,
        status: ((update.status as string | undefined) ?? existing.status) || 'pending',
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[mcp-server/social-approvals] update failed:', err);
    return error.internal(c, 'Failed to update social approval');
  }
});

app.delete('/:id', requireScope('social_posts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Social approval', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'social_approval',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[mcp-server/social-approvals] delete failed:', err);
    return error.internal(c, 'Failed to delete social approval');
  }
});

export default app;

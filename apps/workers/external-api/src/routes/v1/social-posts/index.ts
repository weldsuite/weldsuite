import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  publishPost,
  cancelPost,
  cancelDeliveryBeforeDelete,
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
  type PublishPostOptions,
} from '@weldsuite/social-publishing';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { stripServerFields } from '../../../lib/sanitize';
import { socialContext, resolveClerkOrgId, SOCIAL_LOG_PREFIX } from '../../../lib/social-context';
import {
  createSocialPostSchema,
  updateSocialPostSchema,
} from '@weldsuite/core-api-client/schemas/social-posts';

const listSocialPostsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  status: z.string().optional(),
  campaignId: z.string().optional(),
});

const table = schema.socialPosts;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('social_posts:read'), zValidator('query', listSocialPostsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.status) where.push(eq(table.status, q.status as typeof table.status._.data));
  if (q.campaignId) where.push(eq(table.campaignId, q.campaignId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('social_posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialPost', id);
  return success(c, row);
});

app.post('/', requireScope('social_posts:write'), zValidator('json', createSocialPostSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('userId');
  const now = new Date();
  const id = generateId('socp');
  const [row] = await db
    .insert(table)
    .values({
      // Caller fields first (server-owned keys stripped); server fields below win.
      ...stripServerFields(body as Record<string, unknown>),
      id,
      createdAt: now,
      updatedAt: now,
      // NOT NULL fields: content, targetAccountIds, createdByUserId
      content: body.content ?? '',
      targetAccountIds: body.targetAccountIds ?? body.accountIds ?? [],
      createdByUserId: userId,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create social post');
  publishEntityEvent({
    c,
    entityType: 'social_post',
    entityId: id,
    action: 'created',
    data: { id, status: row.status, createdByUserId: row.createdByUserId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('social_posts:write'), zValidator('json', updateSocialPostSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...stripServerFields(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialPost', id);
  publishEntityEvent({
    c,
    entityType: 'social_post',
    entityId: id,
    action: 'updated',
    data: { id, status: row.status },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('social_posts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [existing] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'SocialPost', id);

  // Stop the upstream delivery before the row goes away. A soft delete on its
  // own leaves the scheduled post live on PostPeer, so it still fires on the
  // customer's real account — and the delivery webhook then skips the
  // soft-deleted row, so nothing records that it went out.
  const deleteOrgId = await resolveClerkOrgId(c.env, c.get('workspaceId'));
  if (deleteOrgId) {
    await cancelDeliveryBeforeDelete(db, socialContext(c.env), deleteOrgId, id);
  } else {
    console.error(
      `${SOCIAL_LOG_PREFIX} cannot cancel delivery for ${id} — workspace is not linked to an organization`,
    );
  }

  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialPost', id);
  publishEntityEvent({
    c,
    entityType: 'social_post',
    entityId: id,
    action: 'deleted',
    data: { id },
  });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Publish / schedule
//
// These call the shared publishing package directly — no other worker is
// involved. The package is what keeps behaviour identical to the platform UI:
// the same atomic claim against double-submission, the same credit metering,
// and the same delivery index (in master, so any worker can write it and
// app-api's PostPeer webhook can still resolve the tenant).
//
// Note that creating a post with `status: 'scheduled'` does NOT schedule it —
// nothing sweeps scheduled rows. A post only reaches PostPeer through these
// endpoints.
// ---------------------------------------------------------------------------

const schedulePostSchema = z.object({
  /** ISO-8601 with offset, e.g. 2026-08-05T09:30:00+02:00. Must be in the future. */
  scheduledAt: z.string().datetime({ offset: true }),
  /** IANA timezone the schedule should be interpreted in (e.g. Europe/Amsterdam). */
  timezone: z.string().max(50).optional(),
});

/**
 * Confirm the post exists in this tenant, then publish or schedule it.
 *
 * The existence check earns its keep twice: it returns the standard v1 404 for
 * an unknown id rather than letting the package raise a generic error, and a
 * 404 is what lets the MCP server's resolve-by-name retry engage when a caller
 * passes a post title where an id was expected.
 */
async function publishOrSchedule(
  c: Context<HonoEnv>,
  id: string,
  options: PublishPostOptions,
) {
  const db = c.get('tenantDb');

  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialPost', id);

  const orgId = await resolveClerkOrgId(c.env, c.get('workspaceId'));
  if (!orgId) {
    return error.internal(c, 'Workspace is not linked to an organization');
  }

  let result: Awaited<ReturnType<typeof publishPost>>;
  try {
    result = await publishPost(db, socialContext(c.env), orgId, id, options);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return c.json(
        {
          error: {
            code: 'SOCIAL_PUBLISHING_NOT_CONFIGURED',
            message: 'Social publishing is not configured',
          },
        },
        503,
      );
    }
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    if (err instanceof SocialInsufficientCreditsError) {
      return c.json(
        {
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: err.message,
            details: {
              currentBalance: err.currentBalance,
              required: err.required,
              shortfall: err.required - err.currentBalance,
            },
          },
        },
        402,
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to publish post';
    console.error(`${SOCIAL_LOG_PREFIX} publish failed:`, err);
    // A post with no targets, or none of them connected, is a caller error.
    const isCallerError =
      message === 'Post has no target accounts' ||
      message === 'No PostPeer-connected accounts among the post targets';
    return isCallerError ? error.badRequest(c, message) : error.internal(c, message);
  }

  // Emitted outside the try, and defensively: the post is live on PostPeer by
  // now, so a failure to announce it must not be reported to the caller as a
  // failed publish — they would retry a post that has already gone out.
  try {
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: options.now ? (result.status === 'failed' ? 'failed' : 'published') : 'scheduled',
      data: { id, status: result.status, postpeerPostId: result.postpeerPostId },
    });
  } catch (err) {
    console.error(`${SOCIAL_LOG_PREFIX} entity event failed after publish:`, err);
  }

  return success(c, result as unknown as Record<string, unknown>);
}

app.post('/:id/publish', requireScope('social_posts:write'), async (c) =>
  publishOrSchedule(c, c.req.param('id'), { now: true }),
);

app.post(
  '/:id/schedule',
  requireScope('social_posts:write'),
  zValidator('json', schedulePostSchema),
  async (c) => {
    const { scheduledAt, timezone } = c.req.valid('json');
    return publishOrSchedule(c, c.req.param('id'), { now: false, scheduledAt, timezone });
  },
);

/**
 * Cancel a scheduled post, keeping the record.
 *
 * This is what callers need to call off a schedule: cancelling on PostPeer is
 * the only thing that stops the delivery, since the scheduled time lives
 * upstream — flipping `status` locally would leave the post to fire anyway. It
 * also refunds the credits charged when the post was scheduled.
 *
 * A post that is already published or mid-publish is a 409: its content is (or
 * is becoming) live on the channels and cannot be recalled.
 */
app.post('/:id/cancel', requireScope('social_posts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const orgId = await resolveClerkOrgId(c.env, c.get('workspaceId'));
  if (!orgId) {
    return error.internal(c, 'Workspace is not linked to an organization');
  }

  try {
    const cancelled = await cancelPost(db, socialContext(c.env), orgId, id);
    if (!cancelled) return error.notFound(c, 'SocialPost', id);
  } catch (err) {
    if (err instanceof SocialPublishConflictError) {
      return error.conflict(c, err.message);
    }
    console.error(`${SOCIAL_LOG_PREFIX} cancel failed:`, err);
    return error.internal(c, err instanceof Error ? err.message : 'Failed to cancel post');
  }

  // Emitted outside the try, and defensively: cancelPost already cancelled the
  // upstream delivery and refunded the credits by now, so a failure to
  // announce it must not be reported to the caller as a failed cancel.
  try {
    publishEntityEvent({
      c,
      entityType: 'social_post',
      entityId: id,
      action: 'cancelled',
      data: { id, status: 'cancelled' },
    });
  } catch (err) {
    console.error(`${SOCIAL_LOG_PREFIX} entity event failed after cancel:`, err);
  }

  return success(c, { id, status: 'cancelled' });
});

export default app;

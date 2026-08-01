import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { stripServerFields } from '../../../lib/sanitize';
import { callAppApiInternal } from '../../../lib/app-api-internal';
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
// These delegate to app-api's internal surface rather than talking to PostPeer
// here — see lib/app-api-internal.ts for why (the delivery webhook resolves the
// tenant through a KV mapping only app-api can write). app-api also emits the
// `social_post` published/scheduled entity event, so these routes deliberately
// do not publish one of their own; doing so would double-fire it.
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
 * Confirm the post exists in this tenant, then hand off to app-api.
 *
 * The local existence check is not redundant: it turns an unknown id into the
 * standard v1 404 (`error.notFound`) instead of the upstream's 400, which is
 * also what lets the MCP server's resolve-by-name retry engage when a caller
 * passes a post title where an id was expected.
 */
async function forwardToAppApi(
  c: Context<HonoEnv>,
  id: string,
  path: string,
  extra: Record<string, unknown> = {},
) {
  const db = c.get('tenantDb');

  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialPost', id);

  const upstream = await callAppApiInternal(c.env, path, {
    workspaceId: c.get('workspaceId'),
    postId: id,
    actorUserId: c.get('userId'),
    ...extra,
  });

  if (upstream.status >= 200 && upstream.status < 300) {
    return success(c, (upstream.body?.data ?? null) as Record<string, unknown>);
  }

  // Forward the upstream code/message verbatim — it already speaks the v1
  // error envelope, and carries statuses (402 insufficient credits, 409
  // conflict, 503 not configured) the local helpers don't all express.
  const upstreamError = upstream.body?.error;
  return c.json(
    {
      error: {
        code: upstreamError?.code ?? 'UPSTREAM_ERROR',
        message: upstreamError?.message ?? 'Failed to reach the publishing service',
        ...(upstreamError?.details !== undefined ? { details: upstreamError.details } : {}),
      },
    },
    upstream.status as ContentfulStatusCode,
  );
}

app.post('/:id/publish', requireScope('social_posts:write'), async (c) =>
  forwardToAppApi(c, c.req.param('id'), '/social-posts/publish'),
);

app.post(
  '/:id/schedule',
  requireScope('social_posts:write'),
  zValidator('json', schedulePostSchema),
  async (c) => {
    const { scheduledAt, timezone } = c.req.valid('json');
    return forwardToAppApi(c, c.req.param('id'), '/social-posts/schedule', { scheduledAt, timezone });
  },
);

export default app;

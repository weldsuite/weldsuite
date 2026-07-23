import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { stripServerFields } from '../../../lib/sanitize';
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

export default app;

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { stripServerFields } from '../../../lib/sanitize';
import {
  createSocialAnalyticsSchema,
  updateSocialAnalyticsSchema,
} from '@weldsuite/core-api-client/schemas/social-analytics';

// social_analytics has no deletedAt — hard deletes, no entity events (no catalog type).

const listSocialAnalyticsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  postId: z.string().optional(),
  accountId: z.string().optional(),
});

const table = schema.socialAnalytics;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('social_analytics:read'), zValidator('query', listSocialAnalyticsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.postId) where.push(eq(table.postId, q.postId));
  if (q.accountId) where.push(eq(table.accountId, q.accountId));
  // No deletedAt on this table — disable soft-delete filter.
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit, softDelete: false });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('social_analytics:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialAnalytics', id);
  return success(c, row);
});

app.post('/', requireScope('social_analytics:write'), zValidator('json', createSocialAnalyticsSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('soan');
  const [row] = await db
    .insert(table)
    .values({
      // Caller fields first (server-owned keys stripped); server fields below win.
      ...stripServerFields(body as Record<string, unknown>),
      id,
      createdAt: now,
      updatedAt: now,
      // NOT NULL fields: postId, accountId, snapshotAt
      postId: body.postId,
      accountId: body.accountId,
      snapshotAt: (body as Record<string, unknown>).snapshotAt as Date ?? now,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create social analytics snapshot');
  // No publishEntityEvent — social_analytics has no catalog entity-event type.
  return success(c, row, 201);
});

app.patch('/:id', requireScope('social_analytics:write'), zValidator('json', updateSocialAnalyticsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...stripServerFields(body as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'SocialAnalytics', id);
  // No publishEntityEvent — social_analytics has no catalog entity-event type.
  return success(c, row);
});

app.delete('/:id', requireScope('social_analytics:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // Hard delete — no deletedAt column on social_analytics.
  const [row] = await db
    .delete(table)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'SocialAnalytics', id);
  // No publishEntityEvent — social_analytics has no catalog entity-event type.
  return noContent(c);
});

export default app;

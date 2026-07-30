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
  createSocialAccountSchema,
  updateSocialAccountSchema,
} from '@weldsuite/core-api-client/schemas/social-accounts';

const listSocialAccountsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  platform: z.string().optional(),
  status: z.string().optional(),
});

const table = schema.socialAccounts;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('social_accounts:read'), zValidator('query', listSocialAccountsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.platform) where.push(eq(table.platform, q.platform as typeof table.platform._.data));
  if (q.status) where.push(eq(table.status, q.status as typeof table.status._.data));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('social_accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialAccount', id);
  return success(c, row);
});

app.post('/', requireScope('social_accounts:write'), zValidator('json', createSocialAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const session = c.get('apiSession');
  const userId = c.get('userId');
  const now = new Date();
  const id = generateId('soca');
  const [row] = await db
    .insert(table)
    .values({
      // Caller fields first (server-owned keys stripped); server fields below win.
      ...stripServerFields(body as Record<string, unknown>),
      id,
      createdAt: now,
      updatedAt: now,
      // NOT NULL fields: platform, platformAccountId, name, connectedByUserId
      platform: (body.platform ?? 'twitter') as typeof table.platform._.data,
      platformAccountId: (body as Record<string, unknown>).platformAccountId as string ?? session.keyId,
      name: (body as Record<string, unknown>).name as string ?? body.displayName ?? body.username ?? 'Unknown',
      connectedByUserId: userId,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create social account');
  publishEntityEvent({
    c,
    entityType: 'social_account',
    entityId: id,
    action: 'created',
    data: { id, platform: row.platform, name: row.name, status: row.status },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('social_accounts:write'), zValidator('json', updateSocialAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...stripServerFields(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialAccount', id);
  publishEntityEvent({
    c,
    entityType: 'social_account',
    entityId: id,
    action: 'updated',
    data: { id, platform: row.platform, name: row.name, status: row.status },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('social_accounts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialAccount', id);
  publishEntityEvent({
    c,
    entityType: 'social_account',
    entityId: id,
    action: 'deleted',
    data: { id, platform: row.platform, name: row.name },
  });
  return noContent(c);
});

export default app;

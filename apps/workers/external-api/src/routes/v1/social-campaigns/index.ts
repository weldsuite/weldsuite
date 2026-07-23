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
  createSocialCampaignSchema,
  updateSocialCampaignSchema,
} from '@weldsuite/core-api-client/schemas/social-campaigns';

const listSocialCampaignsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  status: z.string().optional(),
});

const table = schema.socialCampaigns;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('social_campaigns:read'), zValidator('query', listSocialCampaignsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.status) where.push(eq(table.status, q.status as typeof table.status._.data));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('social_campaigns:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialCampaign', id);
  return success(c, row);
});

app.post('/', requireScope('social_campaigns:write'), zValidator('json', createSocialCampaignSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('userId');
  const now = new Date();
  const id = generateId('socc');
  const [row] = await db
    .insert(table)
    .values({
      // Caller fields first (server-owned keys stripped); server fields below win.
      ...stripServerFields(body as Record<string, unknown>),
      id,
      createdAt: now,
      updatedAt: now,
      // NOT NULL fields: name, createdByUserId
      name: body.name,
      createdByUserId: userId,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create social campaign');
  publishEntityEvent({
    c,
    entityType: 'social_campaign',
    entityId: id,
    action: 'created',
    data: { id, name: row.name, status: row.status },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('social_campaigns:write'), zValidator('json', updateSocialCampaignSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...stripServerFields(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialCampaign', id);
  publishEntityEvent({
    c,
    entityType: 'social_campaign',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name, status: row.status },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('social_campaigns:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialCampaign', id);
  publishEntityEvent({
    c,
    entityType: 'social_campaign',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name },
  });
  return noContent(c);
});

export default app;

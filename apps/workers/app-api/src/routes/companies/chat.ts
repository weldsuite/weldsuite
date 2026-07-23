/**
 * Company chat sub-route — mounted under /api/companies/:id/chat.
 *
 * Self-contained: the route reads the company row directly to derive
 * channel display name + default members (owner, account manager). No
 * registry, no provider lookups — adding a new object panel doesn't need
 * a separate provider file.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema, type Database } from '../../db';
import {
  findEntityChannel,
  getOrCreateEntityChannel,
  postChannelMessage,
} from '../../lib/entity-channel';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  htmlContent: z.string().optional(),
  parentId: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  mentionsEveryone: z.boolean().optional(),
  attachments: z.array(z.record(z.unknown())).optional(),
  metadata: z.record(z.unknown()).optional(),
});

async function loadCompanyInfo(
  db: Database,
  companyId: string,
): Promise<{ displayName: string; defaultMemberIds: string[] } | null> {
  const { companies } = schema;
  const [row] = await db
    .select({
      displayName: companies.displayName,
      name: companies.name,
      ownerId: companies.ownerId,
      accountManagerId: companies.accountManagerId,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .limit(1);
  if (!row) return null;
  const members: string[] = [];
  if (row.ownerId) members.push(row.ownerId);
  if (row.accountManagerId && row.accountManagerId !== row.ownerId) {
    members.push(row.accountManagerId);
  }
  return {
    displayName: row.displayName || row.name || 'Company',
    defaultMemberIds: members,
  };
}

/**
 * GET /api/companies/:id/chat/channel — returns the channel row for this
 * company, or null if no one has posted yet. Never creates.
 */
app.get('/channel', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const companyId = c.req.param('id');
  if (!companyId) return error.badRequest(c, 'Company id is required');
  try {
    const info = await loadCompanyInfo(db, companyId);
    if (!info) return error.notFound(c, 'Company', companyId);
    const channel = await findEntityChannel(db, 'company', companyId);
    return success(c, channel ?? null);
  } catch (err) {
    console.error('[app-api/companies/chat] channel fetch failed:', err);
    return error.internal(c, 'Failed to fetch company channel');
  }
});

/**
 * POST /api/companies/:id/chat/messages — lazily creates the channel and
 * posts the first (or next) message.
 */
app.post(
  '/messages',
  requirePermission('channels:create'),
  zValidator('json', sendMessageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const companyId = c.req.param('id');
    if (!companyId) return error.badRequest(c, 'Company id is required');
    const userId = c.get('userId');
    const input = c.req.valid('json');
    try {
      const info = await loadCompanyInfo(db, companyId);
      if (!info) return error.notFound(c, 'Company', companyId);

      const { channel, created } = await getOrCreateEntityChannel({
        db,
        entityType: 'company',
        entityId: companyId,
        actingUserId: userId,
        info,
      });

      const message = await postChannelMessage({
        db,
        channelId: channel.id,
        authorUserId: userId,
        input,
      });

      return success(c, { channel, message, createdChannel: created }, 201);
    } catch (err) {
      console.error('[app-api/companies/chat] post message failed:', err);
      return error.internal(c, 'Failed to post message');
    }
  },
);

export const companyChatRoutes = app;

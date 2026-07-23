/**
 * Person chat sub-route — mounted under /api/people/:id/chat.
 *
 * Mirrors company chat: reads the person row for displayName + owner/manager,
 * lazily creates the channel on first message. No registry.
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

async function loadPersonInfo(
  db: Database,
  personId: string,
): Promise<{ displayName: string; defaultMemberIds: string[] } | null> {
  const { people } = schema;
  const [row] = await db
    .select({
      displayName: people.displayName,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      ownerId: people.ownerId,
      accountManagerId: people.accountManagerId,
    })
    .from(people)
    .where(and(eq(people.id, personId), isNull(people.deletedAt)))
    .limit(1);
  if (!row) return null;
  const members: string[] = [];
  if (row.ownerId) members.push(row.ownerId);
  if (row.accountManagerId && row.accountManagerId !== row.ownerId) {
    members.push(row.accountManagerId);
  }
  const fromParts = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
  return {
    displayName: row.displayName || row.fullName || fromParts || row.email || 'Person',
    defaultMemberIds: members,
  };
}

app.get('/channel', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const personId = c.req.param('id');
  if (!personId) return error.badRequest(c, 'Person id is required');
  try {
    const info = await loadPersonInfo(db, personId);
    if (!info) return error.notFound(c, 'Person', personId);
    const channel = await findEntityChannel(db, 'person', personId);
    return success(c, channel ?? null);
  } catch (err) {
    console.error('[app-api/people/chat] channel fetch failed:', err);
    return error.internal(c, 'Failed to fetch person channel');
  }
});

app.post(
  '/messages',
  requirePermission('channels:create'),
  zValidator('json', sendMessageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const personId = c.req.param('id');
    if (!personId) return error.badRequest(c, 'Person id is required');
    const userId = c.get('userId');
    const input = c.req.valid('json');
    try {
      const info = await loadPersonInfo(db, personId);
      if (!info) return error.notFound(c, 'Person', personId);

      const { channel, created } = await getOrCreateEntityChannel({
        db,
        entityType: 'person',
        entityId: personId,
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
      console.error('[app-api/people/chat] post message failed:', err);
      return error.internal(c, 'Failed to post message');
    }
  },
);

export const personChatRoutes = app;

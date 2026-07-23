/**
 * WeldChat directories routes — flat /api/chat-directories/* surface.
 *
 * GET /channels — the channel directory: all non-archived public channels,
 * plus any private channels the caller has already joined. Read-only.
 *
 * WeldChat streams over its own ChatRoom DO, not the entity-event bus — no
 * entity events are published here.
 *
 * Permissions: channels:read.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listDirectoryChannelsQuerySchema = z.object({
  search: z.string().optional(),
});

app.get('/channels', requirePermission('channels:read'), zValidator('query', listDirectoryChannelsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { search } = c.req.valid('query');

  try {
    const { chatChannels, chatChannelMembers } = schema;

    const conditions: any[] = [
      isNull(chatChannels.deletedAt),
      eq(chatChannels.isArchived, false),
      or(
        eq(chatChannels.type, 'public'),
        sql`EXISTS (
          SELECT 1 FROM ${chatChannelMembers}
          WHERE ${chatChannelMembers.channelId} = ${chatChannels.id}
            AND ${chatChannelMembers.userId} = ${userId}
        )`,
      )!,
    ];

    if (search) {
      conditions.push(ilike(chatChannels.name, `%${search}%`));
    }

    const rows = await db
      .select({
        id: chatChannels.id,
        name: chatChannels.name,
        description: chatChannels.description,
        memberCount: chatChannels.memberCount,
        type: chatChannels.type,
        isJoined: sql<boolean>`EXISTS (
          SELECT 1 FROM ${chatChannelMembers}
          WHERE ${chatChannelMembers.channelId} = ${chatChannels.id}
            AND ${chatChannelMembers.userId} = ${userId}
        )`,
      })
      .from(chatChannels)
      .where(and(...conditions))
      .orderBy(chatChannels.name);

    const channels = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      memberCount: row.memberCount,
      isJoined: Boolean(row.isJoined),
      type: (row.type === 'public' || row.type === 'private' ? row.type : 'public') as 'public' | 'private',
    }));

    return success(c, channels);
  } catch (err) {
    console.error('[app-api/chat-directories] list channels failed:', err);
    return error.internal(c, 'Failed to fetch directory channels');
  }
});

export const chatDirectoriesRoutes = app;

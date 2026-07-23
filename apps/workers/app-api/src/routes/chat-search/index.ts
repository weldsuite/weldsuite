/**
 * WeldChat search routes — flat /api/chat-search/* surface.
 *
 * Full-text search across chat messages in channels the caller can see
 * (their channel memberships + all public channels). Read-only.
 *
 * WeldChat streams over its own ChatRoom DO, not the entity-event bus — no
 * entity events are published here.
 *
 * Permissions: messages:read.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, isNull, lte } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const searchQuerySchema = z.object({
  q: z.string().min(1),
  channelId: z.string().optional(),
  authorId: z.string().optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

app.get('/', requirePermission('messages:read'), zValidator('query', searchQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { q, channelId, authorId, before, after, limit } = c.req.valid('query');

  try {
    const { chatMessages, chatChannelMembers, chatChannels } = schema;

    // Channels the user is a member of
    const memberChannels = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));
    const memberChannelIds = memberChannels.map((r) => r.channelId);

    // Plus all public channels
    const publicChannels = await db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.type, 'public'), isNull(chatChannels.deletedAt)));
    const publicChannelIds = publicChannels.map((r) => r.id);

    const accessibleChannelIds = Array.from(new Set([...memberChannelIds, ...publicChannelIds]));
    if (accessibleChannelIds.length === 0) {
      return success(c, { messages: [], total: 0 });
    }

    const conditions: any[] = [
      isNull(chatMessages.deletedAt),
      inArray(chatMessages.channelId, accessibleChannelIds),
      ilike(chatMessages.content, `%${q}%`),
    ];

    if (channelId) {
      if (!accessibleChannelIds.includes(channelId)) {
        return success(c, { messages: [], total: 0 });
      }
      conditions.push(eq(chatMessages.channelId, channelId));
    }
    if (authorId) conditions.push(eq(chatMessages.authorId, authorId));
    if (after) conditions.push(gte(chatMessages.createdAt, new Date(after)));
    if (before) conditions.push(lte(chatMessages.createdAt, new Date(before)));

    const messages = await db
      .select({
        id: chatMessages.id,
        channelId: chatMessages.channelId,
        authorId: chatMessages.authorId,
        authorName: chatMessages.authorName,
        authorAvatar: chatMessages.authorAvatar,
        content: chatMessages.content,
        htmlContent: chatMessages.htmlContent,
        type: chatMessages.type,
        parentId: chatMessages.parentId,
        isPinned: chatMessages.isPinned,
        hasAttachments: chatMessages.hasAttachments,
        attachments: chatMessages.attachments,
        reactions: chatMessages.reactions,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(and(...conditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    // Enrich with channel info
    const channelIdSet = new Set(messages.map((m) => m.channelId));
    const channelInfoMap = new Map<string, { name: string; slug: string; type: string }>();
    if (channelIdSet.size > 0) {
      const channels = await db
        .select({
          id: chatChannels.id,
          name: chatChannels.name,
          slug: chatChannels.slug,
          type: chatChannels.type,
        })
        .from(chatChannels)
        .where(inArray(chatChannels.id, Array.from(channelIdSet)));
      for (const ch of channels) {
        channelInfoMap.set(ch.id, { name: ch.name, slug: ch.slug, type: ch.type });
      }
    }

    const results = messages.map((msg) => ({
      ...msg,
      channel: channelInfoMap.get(msg.channelId) ?? null,
    }));

    return success(c, { messages: results, total: results.length });
  } catch (err) {
    console.error('[app-api/chat-search] search failed:', err);
    return error.internal(c, 'Failed to search messages');
  }
});

export const chatSearchRoutes = app;

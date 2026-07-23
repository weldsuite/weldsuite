/**
 * Discord Webhook Routes
 *
 * Handles inbound Discord messages forwarded by the external Discord bot.
 * Mounted BEFORE widgetAuthMiddleware — uses its own auth (X-Bot-Secret header).
 */

import { Hono } from 'hono';
import { eq, and, ne, isNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { generateId } from '../lib/id';
import { success, error } from '../lib/response';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { notifyAgentsOfNewConversation } from '../services/push-notifications';
import { publishEntityEvent } from '../lib/entity-events';

// Use a more relaxed Variables type since we don't have widget auth
type DiscordVariables = Record<string, unknown>;

export const discordRoutes = new Hono<{ Bindings: Env; Variables: DiscordVariables }>();

// ============================================================================
// POST /message — Inbound Discord message from external bot
// ============================================================================

interface DiscordMessagePayload {
  id: string;
  channel_id: string;
  guild_id: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    bot?: boolean;
    avatar?: string;
  };
  content: string;
  timestamp: string;
}

discordRoutes.post('/message', async (c) => {
  // 1. Verify auth
  const botSecret = c.req.header('X-Bot-Secret');
  if (!botSecret || botSecret !== c.env.DISCORD_PUBLIC_KEY) {
    return error.unauthorized(c, 'Invalid bot secret');
  }

  let payload: DiscordMessagePayload;
  try {
    payload = await c.req.json();
  } catch {
    return error.badRequest(c, 'Invalid JSON payload');
  }

  const { guild_id, channel_id, author, content, id: messageDiscordId } = payload;

  if (!guild_id || !channel_id || !author || !content) {
    return error.badRequest(c, 'Missing required fields');
  }

  try {
    // 2. Resolve workspace from KV
    const kvData = await c.env.WORKSPACE_CACHE.get(`discord_guild:${guild_id}`, 'json') as {
      clerkOrgId: string;
      internalWorkspaceId: string;
    } | null;

    if (!kvData) {
      console.warn(`[Discord] No workspace mapping for guild ${guild_id}`);
      return c.json({ success: false, message: 'Guild not configured' }, 404);
    }

    const { clerkOrgId, internalWorkspaceId } = kvData;

    // 3. Get tenant DB
    const db = await getTenantDbForWorkspace(c.env, clerkOrgId);

    // 4. Check integration config
    const [integration] = await db
      .select()
      .from(schema.helpdeskChannelIntegrations)
      .where(
        and(
          eq(schema.helpdeskChannelIntegrations.provider, 'discord'),
          isNull(schema.helpdeskChannelIntegrations.deletedAt),
        ),
      )
      .limit(1);

    if (!integration || integration.status !== 'connected') {
      return c.json({ success: false, message: 'Discord integration not active' }, 404);
    }

    const config = (integration.config || {}) as Record<string, unknown>;

    // Check ignoreBots setting
    if (config.ignoreBots !== false && author.bot) {
      return c.json({ success: true, message: 'Bot message ignored' });
    }

    // Check if channel is in configured supportChannels
    const supportChannels = (config.supportChannels || []) as Array<{ channelId: string; enabled: boolean }>;
    if (supportChannels.length > 0) {
      const channelConfig = supportChannels.find((ch) => ch.channelId === channel_id);
      if (!channelConfig || !channelConfig.enabled) {
        return c.json({ success: true, message: 'Channel not monitored' });
      }
    }

    // Check support prefix
    const supportPrefix = config.supportPrefix as string | undefined;
    if (supportPrefix && !content.startsWith(supportPrefix)) {
      return c.json({ success: true, message: 'Message does not match support prefix' });
    }

    // Strip prefix from content if present
    const messageContent = supportPrefix ? content.slice(supportPrefix.length).trim() : content;
    if (!messageContent) {
      return c.json({ success: true, message: 'Empty message after prefix strip' });
    }

    // 5. Find or create conversation (Discord-specific thread-aware lookup)
    const customerEmail = `discord:${author.id}@discord`;
    const customerName = author.username;

    const [threadConv] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${channel_id}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    // Only process messages for existing ticket conversations (created via the
    // "Open Ticket" button). Don't auto-create conversations from regular channel messages.
    const existingConv = threadConv || (await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          eq(schema.helpdeskConversations.customerEmail, customerEmail),
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1)
    )[0] || null;

    if (!existingConv) {
      return c.json({ success: true, message: 'No active ticket for this channel — ignored' });
    }

    const now = new Date();
    const conversationId = existingConv.id;

    // 6. Publish message to realtime conversation room
    try {
      const realtime = new RealtimePublisher(c.env.REALTIME!);
      const msgId = generateId('msg');
      await realtime.conversationMessage(conversationId, {
        id: msgId,
        content: messageContent,
        senderId: `discord_${author.id}`,
        senderName: customerName,
        senderType: 'customer',
      });

      // Notify workspace channel so agents see the new message
      await realtime.helpdeskEvent(clerkOrgId, 'message_new', {
        conversationId,
        preview: messageContent.substring(0, 200),
        senderName: customerName,
      });
    } catch (realtimeErr) {
      console.error('[Discord] Failed to publish message to realtime:', realtimeErr);
      return error.internal(c, 'Failed to publish message');
    }

    console.log(`[Discord] Published message ${messageDiscordId} to realtime → conversation ${conversationId}`);

    return c.json({ success: true, conversationId });
  } catch (err) {
    console.error('[Discord] Message processing error:', err);
    return error.internal(c, 'Failed to process Discord message');
  }
});

// ============================================================================
// POST /ticket — Create a ticket conversation from a Discord button interaction
// ============================================================================

interface DiscordTicketPayload {
  guild_id: string;
  thread_id: string;
  user: {
    id: string;
    username: string;
    avatar?: string;
  };
}

discordRoutes.post('/ticket', async (c) => {
  // Verify auth
  const botSecret = c.req.header('X-Bot-Secret');
  if (!botSecret || botSecret !== c.env.DISCORD_PUBLIC_KEY) {
    return error.unauthorized(c, 'Invalid bot secret');
  }

  let payload: DiscordTicketPayload;
  try {
    payload = await c.req.json();
  } catch {
    return error.badRequest(c, 'Invalid JSON payload');
  }

  const { guild_id, thread_id, user } = payload;
  if (!guild_id || !thread_id || !user?.id || !user?.username) {
    return error.badRequest(c, 'Missing required fields');
  }

  try {
    // Resolve workspace from KV
    const kvData = await c.env.WORKSPACE_CACHE.get(`discord_guild:${guild_id}`, 'json') as {
      clerkOrgId: string;
      internalWorkspaceId: string;
    } | null;

    if (!kvData) {
      return c.json({ success: false, message: 'Guild not configured' }, 404);
    }

    const { clerkOrgId, internalWorkspaceId } = kvData;
    const db = await getTenantDbForWorkspace(c.env, clerkOrgId);

    const now = new Date();
    const conversationId = generateId('conv');
    const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;
    const customerEmail = `discord:${user.id}@discord`;
    const customerName = user.username;

    await db.insert(schema.helpdeskConversations).values({
      id: conversationId,
      conversationNumber,
      subject: 'Discord Ticket',
      status: 'active',
      channel: 'discord',
      customerEmail,
      customerName,
      customerId: `discord_${user.id}`,
      messageCount: 0,
      unreadCount: 0,
      isRead: false,
      isStarred: false,
      isArchived: false,
      hasAttachments: false,
      tags: [],
      metadata: {
        discordGuildId: guild_id,
        discordChannelId: thread_id,
        discordUserId: user.id,
        discordAvatar: user.avatar,
        isTicket: true,
      },
      createdAt: now,
      updatedAt: now,
    });

    // Publish realtime events
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await new RealtimePublisher(c.env.REALTIME!).helpdeskEvent(clerkOrgId, 'conversation_new', {
            conversationId,
            subject: 'Discord Ticket',
            customerName,
            customerEmail,
            preview: `Ticket opened by ${customerName}`,
            channel: 'discord',
            createdAt: now.toISOString(),
          });
        } catch (err) {
          console.error('[Discord Ticket] Failed to publish realtime events:', err);
        }
      })(),
    );

    // Push notifications
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await notifyAgentsOfNewConversation(db, {
            id: conversationId,
            subject: 'Discord Ticket',
            customerName,
            preview: `Ticket opened by ${customerName}`,
          }, c.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (err) {
          console.error('[Discord Ticket] Push notification error:', err);
        }
      })(),
    );

    // Entity event
    publishEntityEvent({
      c: c as any,
      entityType: 'helpdesk_conversation',
      entityId: conversationId,
      action: 'created',
      data: {
        id: conversationId,
        subject: 'Discord Ticket',
        status: 'active',
        channel: 'discord',
        customerEmail,
        customerName,
      },
    });

    console.log(`[Discord Ticket] Created conversation ${conversationId} for thread ${thread_id}`);

    return c.json({ success: true, conversationId, conversationNumber });
  } catch (err) {
    console.error('[Discord Ticket] Creation error:', err);
    return error.internal(c, 'Failed to create ticket conversation');
  }
});

// ============================================================================
// POST /ticket-close — Close a ticket conversation from a Discord button
// ============================================================================

discordRoutes.post('/ticket-close', async (c) => {
  const botSecret = c.req.header('X-Bot-Secret');
  if (!botSecret || botSecret !== c.env.DISCORD_PUBLIC_KEY) {
    return error.unauthorized(c, 'Invalid bot secret');
  }

  let payload: { guild_id: string; thread_id: string };
  try {
    payload = await c.req.json();
  } catch {
    return error.badRequest(c, 'Invalid JSON payload');
  }

  const { guild_id, thread_id } = payload;
  if (!guild_id || !thread_id) {
    return error.badRequest(c, 'Missing required fields');
  }

  try {
    const kvData = await c.env.WORKSPACE_CACHE.get(`discord_guild:${guild_id}`, 'json') as {
      clerkOrgId: string;
      internalWorkspaceId: string;
    } | null;

    if (!kvData) {
      return c.json({ success: false, message: 'Guild not configured' }, 404);
    }

    const { clerkOrgId } = kvData;
    const db = await getTenantDbForWorkspace(c.env, clerkOrgId);

    // Find conversation by thread ID in metadata
    const [conv] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${thread_id}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    if (!conv) {
      return c.json({ success: false, message: 'Conversation not found' }, 404);
    }

    await db
      .update(schema.helpdeskConversations)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conv.id));

    publishEntityEvent({
      c: c as any,
      entityType: 'helpdesk_conversation',
      entityId: conv.id,
      action: 'updated',
      data: { id: conv.id, status: 'closed' },
    });

    console.log(`[Discord Ticket] Closed conversation ${conv.id} for thread ${thread_id}`);

    return c.json({ success: true, conversationId: conv.id });
  } catch (err) {
    console.error('[Discord Ticket] Close error:', err);
    return error.internal(c, 'Failed to close ticket conversation');
  }
});

// NOTE: Discord Interactions endpoint has been moved to apps/tools/discord-bot (Hetzner).
// The discord-bot handles all INTERACTION_CREATE events (open_ticket, close_ticket, wf_*).
// This file only handles webhook callbacks from the bot: /message, /ticket, /ticket-close.

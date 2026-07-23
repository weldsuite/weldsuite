/**
 * Discord MESSAGE_CREATE Handler
 *
 * Processes inbound Discord messages and persists them to the helpdesk.
 *
 * Only processes messages inside existing ticket threads (created via the
 * "Open Ticket" button interaction). Messages in regular channels are ignored.
 */

import {
  Message,
  type ThreadChannel,
} from 'discord.js';
import { eq, and, ne, isNull, sql } from 'drizzle-orm';
import { getTenantDb, schema } from '../lib/db.js';
import { resolveGuild } from '../lib/guild-cache.js';
import { generateId } from '../lib/id.js';
import { executeWorkflows } from '../engine/executor.js';
import { publishConversationEvent } from '../lib/realtime.js';

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages and system messages
  if (message.author.bot || message.system) return;

  // Only process messages from guilds (not DMs)
  if (!message.guild) return;

  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const author = message.author;
  const content = message.content;

  if (!content?.trim()) return;

  // Only process messages inside threads (ticket threads created via "Open Ticket" button).
  // Messages in regular channels are ignored — no auto-thread creation.
  if (!message.channel.isThread()) return;

  const parentChannelId = (message.channel as ThreadChannel).parentId;

  try {
    // 1. Resolve workspace from guild
    const guildMapping = await resolveGuild(guildId);
    if (!guildMapping) return;

    const { clerkOrgId } = guildMapping;
    const db = await getTenantDb(clerkOrgId);

    // 2. Check integration config
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

    if (!integration || integration.status !== 'connected') return;

    const config = (integration.config || {}) as Record<string, unknown>;

    // Check if parent channel is monitored
    const supportChannels = (config.supportChannels || []) as Array<{ channelId: string; enabled: boolean }>;
    if (supportChannels.length > 0) {
      const channelConfig = supportChannels.find(
        (ch) => ch.channelId === channelId || ch.channelId === parentChannelId,
      );
      if (!channelConfig || !channelConfig.enabled) return;
    }

    // 3. Find existing ticket conversation for this thread
    const threadChannelId = channelId;

    const [existingConv] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${threadChannelId}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    if (!existingConv) return; // Not a known ticket thread — ignore

    // 4. Resolve person for author name.
    let customerEmail = `discord:${author.id}@discord`;
    let customerName = author.displayName || author.username;

    try {
      const [identity] = await db
        .select({
          personId: schema.contactExternalIdentities.personId,
          externalEmail: schema.contactExternalIdentities.externalEmail,
        })
        .from(schema.contactExternalIdentities)
        .where(
          and(
            eq(schema.contactExternalIdentities.provider, 'discord'),
            eq(schema.contactExternalIdentities.externalId, author.id),
          ),
        )
        .limit(1);

      if (identity) {
        if (identity.externalEmail) customerEmail = identity.externalEmail;

        if (identity.personId) {
          const [person] = await db
            .select({
              fullName: schema.people.fullName,
              displayName: schema.people.displayName,
            })
            .from(schema.people)
            .where(eq(schema.people.id, identity.personId))
            .limit(1);

          if (person?.fullName) customerName = person.fullName;
          else if (person?.displayName) customerName = person.displayName;
        }
      }
    } catch {
      // Non-fatal — continue with defaults
    }

    const messageContent = content;
    const now = new Date();
    const conversationId = existingConv.id;

    // 5. Persist message to helpdeskConversationMessages
    const msgId = generateId('msg');

    await db.insert(schema.helpdeskConversationMessages).values({
      id: msgId,
      conversationId,
      authorId: `discord_${author.id}`,
      authorName: customerName,
      authorType: 'customer',
      content: messageContent,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      metadata: {
        discordMessageId: message.id,
        discordChannelId: threadChannelId,
        channel: 'discord',
      },
      createdAt: now,
      updatedAt: now,
    });

    // 6. Publish message to ConversationRoom (real-time for platform agents)
    publishConversationEvent(conversationId, {
      type: 'message',
      id: msgId,
      content: messageContent,
      senderId: `discord_${author.id}`,
      senderName: customerName,
      senderType: 'customer',
      ts: Date.now(),
    });

    // 7. Update conversation counters
    await db
      .update(schema.helpdeskConversations)
      .set({
        lastMessage: messageContent.substring(0, 500),
        preview: messageContent.substring(0, 200),
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        messageCount: sql`${schema.helpdeskConversations.messageCount} + 1`,
        unreadCount: sql`${schema.helpdeskConversations.unreadCount} + 1`,
        isRead: false,
        updatedAt: now,
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    console.log(`[Discord] Message ${message.id} → conversation ${conversationId} (thread: ${threadChannelId})`);

    // 8. Execute message_received workflows (fire-and-forget)
    executeWorkflows({
      db,
      conversationId,
      workspaceId: clerkOrgId,
      eventType: 'message_received',
      channelObj: message.channel as any,
      triggerData: {
        conversationId,
        workspaceId: clerkOrgId,
        channel: 'discord',
        customerName,
        customerEmail,
        content: messageContent,
        messageId: msgId,
        authorType: 'customer',
        authorName: customerName,
        timestamp: new Date().toISOString(),
      },
    }).catch((err) => {
      console.error('[Discord] message_received workflow failed:', err);
    });
  } catch (err) {
    console.error(`[Discord] Failed to process message ${message.id}:`, err);
  }
}

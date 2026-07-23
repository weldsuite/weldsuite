/**
 * Discord Typing Handler
 *
 * Direction 1: Discord user typing → publish to ConversationRoom → platform shows indicator
 * Direction 2: Platform agent typing → ConversationRoom broadcasts → bot calls channel.sendTyping()
 *
 * Discord typing indicators last ~10 seconds. The platform's RoomClient auto-stops after 5s.
 */

import type { Typing } from 'discord.js';
import { eq, and, ne, isNull, sql } from 'drizzle-orm';
import { getTenantDb, schema } from '../lib/db.js';
import { resolveGuild } from '../lib/guild-cache.js';
import { publishConversationEvent } from '../lib/realtime.js';

/**
 * Handle Discord typingStart event — forward to ConversationRoom.
 */
export async function handleTypingStart(typing: Typing): Promise<void> {
  // Ignore bot typing
  if (typing.user?.bot) return;
  if (!typing.guild) return;

  try {
    const guildMapping = await resolveGuild(typing.guild.id);
    if (!guildMapping) return;

    const db = await getTenantDb(guildMapping.clerkOrgId);
    const channelId = typing.channel.id;

    // Find conversation by Discord channel/thread ID
    const [conv] = await db
      .select({ id: schema.helpdeskConversations.id })
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${channelId}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    if (!conv) return;

    // Publish typing event to ConversationRoom
    publishConversationEvent(conv.id, {
      type: 'typing',
      userId: `discord_${typing.user?.id || 'unknown'}`,
      userName: typing.user?.displayName || typing.user?.username || 'Someone',
      isTyping: true,
      ts: Date.now(),
    });
  } catch {
    // Non-fatal — typing indicators are best-effort
  }
}

/**
 * Insert a WeldChat message authored by a workspace agent.
 *
 * Separate from `postChatMessage` (human path) so we never accidentally
 * attribute agent replies to a workspace member or spam human push for
 * agent→agent hops. Mention chaining is the caller's job (see
 * `dispatchAgentRoomReplies`).
 */

import { eq, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';

export interface PostAgentChatMessageInput {
  content: string;
  parentId?: string | null;
  mentions?: string[];
  /** Loop depth of this reply (0 = direct response to a human). */
  hop?: number;
  metadata?: Record<string, unknown>;
}

export interface PostAgentChatMessageContext {
  db: Database;
  env: Env;
  orgId: string;
  channelId: string;
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
  /** Human who originally triggered the chain (for credits / audit). */
  invokerUserId: string;
}

export function extractChatMentions(content: string, extra: string[] = []): string[] {
  const found: string[] = [...extra];
  const mentionRegex = /<@([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(content)) !== null) {
    const body = match[1];
    const colonIdx = body.indexOf(':');
    const mentionId = colonIdx === -1 ? body : body.slice(0, colonIdx);
    if (
      mentionId &&
      mentionId !== 'everyone' &&
      !mentionId.startsWith('entity:') &&
      !found.includes(mentionId)
    ) {
      found.push(mentionId);
    }
  }
  return found;
}

function getPublisher(env: Env): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

export async function postAgentChatMessage(
  ctx: PostAgentChatMessageContext,
  input: PostAgentChatMessageInput,
): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, env, orgId, channelId, agentId, agentName, agentIcon, invokerUserId } = ctx;
  const { chatMessages, chatChannels, chatChannelMembers } = schema;
  const rt = getPublisher(env);

  const id = generateId('msg');
  const now = new Date();
  const hop = input.hop ?? 0;
  const allMentions = extractChatMentions(input.content, input.mentions ?? []);

  await db.insert(chatMessages).values({
    id,
    channelId,
    authorId: agentId,
    authorName: agentName,
    authorAvatar: agentIcon ?? null,
    authorType: 'agent',
    content: input.content,
    parentId: input.parentId ?? null,
    mentions: allMentions.length > 0 ? allMentions : null,
    mentionsEveryone: false,
    metadata: {
      ...(input.metadata ?? {}),
      agentHop: hop,
      invokerUserId,
    },
    createdAt: now,
    updatedAt: now,
  });

  const preview = input.content.length > 100 ? `${input.content.slice(0, 100)}...` : input.content;
  await db
    .update(chatChannels)
    .set({
      lastMessageAt: now,
      lastMessagePreview: preview,
      messageCount: sql`${chatChannels.messageCount} + 1`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  if (input.parentId) {
    await db
      .update(chatMessages)
      .set({
        threadReplyCount: sql`${chatMessages.threadReplyCount} + 1`,
        threadLastReplyAt: now,
        updatedAt: now,
      })
      .where(eq(chatMessages.id, input.parentId));
  }

  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);

  if (rt) {
    try {
      await rt.chatMessage(channelId, {
        id,
        content: input.content,
        senderId: agentId,
        senderName: agentName,
        senderAvatar: agentIcon ?? undefined,
        authorType: 'agent',
        threadId: input.parentId ?? undefined,
      });
    } catch (e) {
      console.error('[app-api/chat] agent message realtime publish failed:', e);
    }

    try {
      const members = await db
        .select({ userId: chatChannelMembers.userId, memberType: chatChannelMembers.memberType })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.channelId, channelId));
      for (const member of members) {
        if (member.memberType === 'agent' || member.userId === agentId) continue;
        try {
          await rt.chatUserUnreadUpdate(orgId, member.userId, { channelId, unreadCount: 1 });
        } catch {
          /* non-critical */
        }
      }
    } catch (e) {
      console.error('[app-api/chat] agent unread fan-out failed:', e);
    }
  }

  return message;
}

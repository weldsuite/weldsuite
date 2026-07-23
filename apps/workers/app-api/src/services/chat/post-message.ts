/**
 * Shared WeldChat message-send implementation (app-api).
 *
 * Handles inserting the message row, updating channel denormalized fields,
 * extracting @mentions from content tokens, bumping thread reply counts +
 * notifying thread participants, publishing realtime events over the
 * ChatRoom / WorkspaceHub DOs (REALTIME binding), and sending mention +
 * unread notifications.
 *
 * Ported from api-worker's services/chat/post-message.ts. WeldChat streams
 * over its own ChatRoom DO, not the entity-event bus.
 */

import { and, eq, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  sendChatMentionNotification,
  sendChatThreadReplyNotification,
  sendChatDmNotification,
} from '@weldsuite/notifications';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';
import { dispatchAgentMentions } from './agent-mention-dispatch';

// Runtime allow-list used to classify chat mention tokens. Mirrors
// SEARCH_ENTITY_TYPES in @weldsuite/core-api-client/schemas/search; inlined
// here to keep app-api off the obsolete core-api-client package.
const SEARCH_ENTITY_TYPES_SET: ReadonlySet<string> = new Set<string>([
  'contact',
  'customer',
  'lead',
  'opportunity',
  'ticket',
  'article',
  'product',
  'order',
  'invoice',
  'bill',
  'project',
  'task',
  'domain',
]);

export interface PostChatMessageInput {
  content: string;
  htmlContent?: string;
  parentId?: string | null;
  attachments?: Array<Record<string, unknown>>;
  mentions?: string[];
  metadata?: Record<string, unknown>;
}

export interface PostChatMessageContext {
  db: Database;
  env: Env;
  orgId: string;
  channelId: string;
  authorUserId: string;
  /** `c.executionCtx.waitUntil` — keeps agent-mention dispatch alive after the
   *  response returns without blocking it. Optional: absent (tests/local), the
   *  dispatch promise simply floats. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

function getPublisher(env: Env): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

export async function postChatMessage(
  ctx: PostChatMessageContext,
  input: PostChatMessageInput,
): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, env, orgId, channelId, authorUserId } = ctx;
  const { chatMessages, chatChannels, chatChannelMembers, workspaceMembers } = schema;
  const rt = getPublisher(env);

  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, authorUserId))
    .limit(1);

  const id = generateId('msg');
  const now = new Date();
  const hasAttachments = !!(input.attachments && input.attachments.length > 0);

  // Classify `<@…>` tokens by prefix:
  //   <@userId>             → user mention (raw userId)
  //   <@userId:DisplayName> → user mention (keep userId, drop label)
  //   <@type:id|Label>      → entity reference (stored as "entity:type:id")
  const contentMentions: string[] = [];
  const mentionRegex = /<@([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(input.content)) !== null) {
    const body = match[1];
    const colonIdx = body.indexOf(':');
    let mentionId: string;
    if (colonIdx === -1) {
      mentionId = body;
    } else {
      const prefix = body.slice(0, colonIdx);
      const rest = body.slice(colonIdx + 1);
      if (SEARCH_ENTITY_TYPES_SET.has(prefix)) {
        const pipeIdx = rest.indexOf('|');
        const entId = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
        mentionId = entId ? `entity:${prefix}:${entId}` : prefix;
      } else {
        mentionId = prefix;
      }
    }
    if (!contentMentions.includes(mentionId)) contentMentions.push(mentionId);
  }
  const allMentions = Array.from(new Set([...(input.mentions ?? []), ...contentMentions]));
  const mentionsEveryone = allMentions.includes('everyone');

  await db.insert(chatMessages).values({
    id,
    channelId,
    authorId: authorUserId,
    authorName: author?.name ?? 'Unknown',
    authorAvatar: author?.picture ?? null,
    content: input.content,
    htmlContent: input.htmlContent,
    parentId: input.parentId,
    attachments: input.attachments as never,
    hasAttachments,
    mentions: allMentions.length > 0 ? allMentions : null,
    mentionsEveryone,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  });

  const preview = input.content.length > 100 ? input.content.slice(0, 100) + '...' : input.content;
  await db
    .update(chatChannels)
    .set({
      lastMessageAt: now,
      lastMessagePreview: preview,
      messageCount: sql`${chatChannels.messageCount} + 1`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  // Advance the author's own read marker to their just-sent message. Without
  // this, lastMessageAt jumps past the author's lastReadAt and their own DM/
  // channel renders as "unread" (gray row + accent timestamp) until they
  // re-open it. You've obviously read your own message.
  await db
    .update(chatChannelMembers)
    .set({ lastReadAt: now, lastReadMessageId: id })
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, authorUserId)));

  if (input.parentId) {
    const [parent] = await db
      .select({
        threadParticipantIds: chatMessages.threadParticipantIds,
        authorId: chatMessages.authorId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, input.parentId))
      .limit(1);

    const participants: string[] = parent?.threadParticipantIds ?? [];
    if (!participants.includes(authorUserId)) participants.push(authorUserId);
    if (parent?.authorId && !participants.includes(parent.authorId)) {
      participants.push(parent.authorId);
    }

    await db
      .update(chatMessages)
      .set({
        threadReplyCount: sql`${chatMessages.threadReplyCount} + 1`,
        threadLastReplyAt: now,
        threadParticipantIds: participants,
        updatedAt: now,
      })
      .where(eq(chatMessages.id, input.parentId));

    const authorName = author?.name ?? 'Unknown';
    for (const participantId of participants) {
      if (participantId === authorUserId) continue;
      if (rt) {
        try {
          await rt.chatUserThreadReply(orgId, participantId, {
            channelId,
            parentMessageId: input.parentId,
            replyMessageId: id,
            authorName,
            preview,
          });
        } catch (e) {
          console.error('[app-api/chat] thread reply realtime publish failed:', e);
        }
      }
      try {
        await sendChatThreadReplyNotification({
          db,
          env,
          workspaceId: orgId,
          recipientUserId: participantId,
          authorUserId,
          authorName,
          channelId,
          parentMessageId: input.parentId,
          replyMessageId: id,
          preview,
        });
      } catch (e) {
        console.error('[app-api/chat] thread reply notification failed:', e);
      }
    }
  }

  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);

  if (rt) {
    try {
      await rt.chatMessage(channelId, {
        id,
        content: input.content,
        senderId: authorUserId,
        senderName: author?.name ?? 'Unknown',
        senderAvatar: author?.picture ?? undefined,
        authorType: 'user',
        threadId: input.parentId ?? undefined,
      });
    } catch (e) {
      console.error('[app-api/chat] message realtime publish failed:', e);
    }
  }

  // Direct-message push: a DM always notifies the other member(s) with the
  // message preview (subject to their notification prefs). Top-level only —
  // thread replies are already covered by the thread-participant notifications
  // above. Recipients already mention-notified are skipped to avoid a double
  // ping. Mirrors the platform behaviour so notifications fire regardless of
  // which send endpoint the client uses.
  if (!input.parentId) {
    try {
      const [channel] = await db
        .select({ type: chatChannels.type })
        .from(chatChannels)
        .where(eq(chatChannels.id, channelId))
        .limit(1);
      if (channel?.type === 'dm') {
        const dmMembers = await db
          .select({ userId: chatChannelMembers.userId })
          .from(chatChannelMembers)
          .where(eq(chatChannelMembers.channelId, channelId));
        const authorName = author?.name ?? 'Unknown';
        for (const m of dmMembers) {
          if (m.userId === authorUserId || allMentions.includes(m.userId)) continue;
          try {
            await sendChatDmNotification({
              db,
              env,
              workspaceId: orgId,
              recipientUserId: m.userId,
              senderUserId: authorUserId,
              senderName: authorName,
              channelId,
              preview,
            });
          } catch (e) {
            console.error('[app-api/chat] DM notification failed:', e);
          }
        }
      }
    } catch (e) {
      console.error('[app-api/chat] DM notification lookup failed:', e);
    }
  }

  if (allMentions.length > 0) {
    const authorName = author?.name ?? 'Unknown';
    for (const mentionedUserId of allMentions) {
      if (mentionedUserId === authorUserId || mentionedUserId === 'everyone') continue;
      // Skip entity tags — stored for future search/notification partitioning
      // but do NOT trigger user-mention notifications today.
      if (mentionedUserId.startsWith('entity:')) continue;

      try {
        await db
          .update(chatChannelMembers)
          .set({ unreadMentionCount: sql`${chatChannelMembers.unreadMentionCount} + 1` })
          .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, mentionedUserId)));
      } catch (e) {
        console.error('[app-api/chat] mention count increment failed:', e);
      }

      if (rt) {
        try {
          await rt.chatUserMention(orgId, mentionedUserId, { channelId, messageId: id, authorName, preview });
        } catch (e) {
          console.error('[app-api/chat] mention realtime publish failed:', e);
        }
      }
      try {
        await sendChatMentionNotification({
          db,
          env,
          workspaceId: orgId,
          mentionedUserId,
          authorUserId,
          authorName,
          channelId,
          messageId: id,
          preview,
        });
      } catch (e) {
        console.error('[app-api/chat] mention notification failed:', e);
      }
    }
  }

  if (rt) {
    try {
      const members = await db
        .select({ userId: chatChannelMembers.userId })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.channelId, channelId));

      for (const member of members) {
        if (member.userId === authorUserId) continue;
        try {
          await rt.chatUserUnreadUpdate(orgId, member.userId, { channelId, unreadCount: 1 });
        } catch {
          /* non-critical */
        }
      }
    } catch (e) {
      console.error('[app-api/chat] unread fan-out failed:', e);
    }
  }

  return message;
}

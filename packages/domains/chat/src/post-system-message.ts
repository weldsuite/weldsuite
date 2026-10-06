/**
 * Insert a WeldChat message authored by a WeldConnect workflow run.
 *
 * Distinct from `postAgentChatMessage` (AI agent replies, `authorType:
 * 'agent'`) and the human send pipeline (chat-api's `postChatMessage`): a
 * workflow step's message is attributed to the *workflow itself*
 * (`authorType: 'system'`, `authorId: 'workflow:<workflowId>'`), never to the
 * workflow's owner — the message must never look like it was typed by a
 * teammate.
 *
 * Replicates the parts of the human send pipeline
 * (apps/workers/chat-api/src/services/chat/post-message.ts) that matter for a
 * channel to behave the same no matter which path wrote the message: the
 * channel's denormalised last-message fields, the realtime broadcast over the
 * ChatRoom DO, and the unread / mention counters other members rely on.
 * Deliberately narrower: no threads, no inline replies, no DM push, no agent
 * room dispatch — a workflow step posts a single top-level channel message.
 */

import { and, eq, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { sendChatMentionNotification, type NotificationEnv } from '@weldsuite/notifications';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { extractChatMentions } from './post-agent-message';

/** The bindings the realtime fan-out and the mention notification read. */
export type PostSystemMessageEnv = NotificationEnv;

export interface PostSystemChatMessageInput {
  content: string;
  /** Extra mentions beyond what `<@…>` tokens in the content already carry. */
  mentions?: string[];
}

export interface PostSystemChatMessageContext {
  db: Database;
  env: PostSystemMessageEnv;
  orgId: string;
  channelId: string;
  /** Stable author id for the workflow, e.g. `workflow:<workflowId>`. */
  authorId: string;
  /** Workflow name shown as the message's author. */
  authorName: string;
  /** The workflow's owner — used only to attribute mention notifications, never as the message's author. */
  invokerUserId: string;
}

function getPublisher(env: PostSystemMessageEnv): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

/** Whether a mention token refers to a human user who should be notified. */
function isNotifiableMention(mentionedUserId: string): boolean {
  if (mentionedUserId === 'everyone') return false;
  // Entity tags (`<@type:id>`) are not a user mention. `extractChatMentions`
  // (shared with postAgentChatMessage) slices a token at its first colon, so
  // an `entity:ticket:tic_1` token arrives here as the bare prefix `entity`,
  // not `entity:ticket:tic_1` — both forms are excluded.
  if (mentionedUserId === 'entity' || mentionedUserId.startsWith('entity:')) return false;
  // Agents are not human recipients.
  return !mentionedUserId.startsWith('agt_');
}

/** Bump every human member's unread counter — mirrors `fanOutUnreadUpdates` in post-message.ts. */
async function fanOutUnreadUpdates(
  db: Database,
  rt: RealtimePublisher,
  orgId: string,
  channelId: string,
): Promise<void> {
  const { chatChannelMembers } = schema;
  try {
    const members = await db
      .select({ userId: chatChannelMembers.userId, memberType: chatChannelMembers.memberType })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));
    for (const member of members) {
      if (member.memberType === 'agent') continue;
      try {
        await rt.chatUserUnreadUpdate(orgId, member.userId, { channelId, unreadCount: 1 });
      } catch {
        /* non-critical */
      }
    }
  } catch (e) {
    console.error('[chat-domain] workflow message unread fan-out failed:', e);
  }
}

/** Mention counter, realtime ping and notification for each mentioned user — mirrors `notifyMentionedUsers`. */
async function notifyMentionedUsers(
  ctx: PostSystemChatMessageContext,
  rt: RealtimePublisher | null,
  allMentions: string[],
  messageId: string,
  preview: string,
): Promise<void> {
  const { db, env, orgId, channelId, authorName, invokerUserId } = ctx;
  const { chatChannelMembers } = schema;

  for (const mentionedUserId of allMentions) {
    if (!isNotifiableMention(mentionedUserId)) continue;

    try {
      await db
        .update(chatChannelMembers)
        .set({ unreadMentionCount: sql`${chatChannelMembers.unreadMentionCount} + 1` })
        .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, mentionedUserId)));
    } catch (e) {
      console.error('[chat-domain] workflow mention count increment failed:', e);
    }

    if (rt) {
      try {
        await rt.chatUserMention(orgId, mentionedUserId, { channelId, messageId, authorName, preview });
      } catch (e) {
        console.error('[chat-domain] workflow mention realtime publish failed:', e);
      }
    }
    try {
      await sendChatMentionNotification({
        db,
        env,
        workspaceId: orgId,
        mentionedUserId,
        // Attribution for the notification only — the message's own author
        // stays the workflow (see postSystemChatMessage below).
        authorUserId: invokerUserId,
        authorName,
        channelId,
        messageId,
        preview,
      });
    } catch (e) {
      console.error('[chat-domain] workflow mention notification failed:', e);
    }
  }
}

export async function postSystemChatMessage(
  ctx: PostSystemChatMessageContext,
  input: PostSystemChatMessageInput,
): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, env, orgId, channelId, authorId, authorName } = ctx;
  const { chatMessages, chatChannels } = schema;
  const rt = getPublisher(env);

  const id = generateId('msg');
  const now = new Date();
  const allMentions = extractChatMentions(input.content, input.mentions ?? []);
  const mentionsEveryone = allMentions.includes('everyone');

  await db.insert(chatMessages).values({
    id,
    channelId,
    authorId,
    authorName,
    authorType: 'system',
    content: input.content,
    mentions: allMentions.length > 0 ? allMentions : null,
    mentionsEveryone,
    metadata: { postedByWorkflow: true },
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

  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);

  if (rt) {
    try {
      await rt.chatMessage(channelId, {
        id,
        content: input.content,
        senderId: authorId,
        senderName: authorName,
        authorType: 'system',
      });
    } catch (e) {
      console.error('[chat-domain] workflow message realtime publish failed:', e);
    }
    await fanOutUnreadUpdates(db, rt, orgId, channelId);
  }

  await notifyMentionedUsers(ctx, rt, allMentions, id, preview);

  return message;
}

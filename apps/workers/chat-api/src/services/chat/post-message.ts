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

import { and, eq, isNull, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  sendChatMentionNotification,
  sendChatThreadReplyNotification,
  sendChatDmNotification,
} from '@weldsuite/notifications';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env } from '../../types';
import { enqueueWeldAgentJob } from '@weldsuite/agent-domain/jobs';
import { parseAgentRoomPolicy } from '@weldsuite/chat-domain/agent-room-policy';
import {
  checkSlowMode,
  getChannelFeatureFlags,
} from './channel-features';

/** Thrown when a channel feature flag / slow-mode check rejects the send. */
export class ChatFeatureError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = 'ChatFeatureError';
  }
}

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
  /**
   * Discord-style inline reply: the id of a message in the same channel this
   * one answers. The message stays top-level (visible in the channel, unlike a
   * thread reply) and carries a server-built snapshot of the quoted message in
   * `metadata.replyTo` (see {@link ChatReplyReference}).
   */
  replyToId?: string | null;
  /** Ping the author of `replyToId` (Discord's "@ ON"). Defaults to true. */
  replyMention?: boolean;
}

/**
 * Snapshot of the message an inline reply answers, stored at
 * `chat_messages.metadata.replyTo`. `depth` is the reply's position in the
 * chain (a reply to a plain message is 1, a reply to that reply 2, …) and
 * `rootId` is the message that started the chain, so clients can suggest
 * moving a long back-and-forth into a thread on the root.
 */
export interface ChatReplyReference {
  messageId: string;
  rootId: string;
  depth: number;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  hasAttachments: boolean;
}

const REPLY_SNIPPET_LENGTH = 200;

/** Truncate a quoted message without leaving half a `<@…>` token behind. */
function replySnippet(content: string): string {
  if (content.length <= REPLY_SNIPPET_LENGTH) return content;
  return content.slice(0, REPLY_SNIPPET_LENGTH).replace(/<@[^>]*$/, '').trimEnd() + '…';
}

function readReplyReference(metadata: unknown): ChatReplyReference | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const ref = (metadata as Record<string, unknown>).replyTo;
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as Partial<ChatReplyReference>;
  return typeof r.messageId === 'string' ? (r as ChatReplyReference) : null;
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

/** Reject the send when the channel is missing or its feature flags / slow mode forbid it. */
async function assertChannelAllowsSend(
  db: Database,
  channelId: string,
  authorUserId: string,
  input: PostChatMessageInput,
): Promise<void> {
  const flags = await getChannelFeatureFlags(db, channelId);
  if (!flags) {
    throw new ChatFeatureError('Channel not found', 404);
  }
  if (input.parentId && !flags.threadsEnabled) {
    throw new ChatFeatureError('Threads are disabled in this channel');
  }
  if (input.attachments?.length && !flags.attachmentsEnabled) {
    throw new ChatFeatureError('Attachments are disabled in this channel');
  }
  if (input.parentId) {
    await assertThreadParentInChannel(db, channelId, input.parentId);
  }
  const slowModeError = await checkSlowMode(db, channelId, authorUserId, flags.slowModeSeconds);
  if (slowModeError) {
    throw new ChatFeatureError(slowModeError);
  }
}

/**
 * A thread reply must hang off a live message of the SAME channel. Without
 * this a caller could name any message id as `parentId`: the reply was stored
 * in the target channel while the foreign parent's reply counter and
 * participant list moved, and the target channel's `threadsEnabled` flag only
 * ever guarded the channel being posted to. A parent that is itself a thread
 * reply is allowed (existing data has them).
 */
async function assertThreadParentInChannel(
  db: Database,
  channelId: string,
  parentId: string,
): Promise<void> {
  const { chatMessages } = schema;
  const [parent] = await db
    .select({ channelId: chatMessages.channelId })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, parentId), isNull(chatMessages.deletedAt)))
    .limit(1);
  if (!parent || parent.channelId !== channelId) {
    throw new ChatFeatureError('Thread parent message not found in this channel');
  }
}

/**
 * Inline reply: snapshot the quoted message (same channel only). A target
 * that vanished (deleted while the reply was being typed) just drops the
 * reference — the message itself still goes out. A client-supplied
 * `metadata.replyTo` is always discarded so a quote can't be forged.
 */
async function resolveInlineReply(
  db: Database,
  channelId: string,
  authorUserId: string,
  input: PostChatMessageInput,
): Promise<{ metadata: Record<string, unknown> | undefined; replyMentions: string[] }> {
  const { chatMessages } = schema;
  let metadata = input.metadata;
  if (metadata && 'replyTo' in metadata) {
    const { replyTo: _forged, ...rest } = metadata;
    metadata = rest;
  }
  const replyMentions: string[] = [];
  if (!input.replyToId) return { metadata, replyMentions };

  const [target] = await db
    .select({
      id: chatMessages.id,
      authorId: chatMessages.authorId,
      authorName: chatMessages.authorName,
      authorAvatar: chatMessages.authorAvatar,
      content: chatMessages.content,
      hasAttachments: chatMessages.hasAttachments,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, input.replyToId),
        eq(chatMessages.channelId, channelId),
        isNull(chatMessages.deletedAt),
      ),
    )
    .limit(1);
  if (!target) return { metadata, replyMentions };

  const previous = readReplyReference(target.metadata);
  const replyTo: ChatReplyReference = {
    messageId: target.id,
    rootId: previous?.rootId ?? target.id,
    depth: (previous?.depth ?? 0) + 1,
    authorId: target.authorId,
    authorName: target.authorName,
    authorAvatar: target.authorAvatar ?? null,
    content: replySnippet(target.content),
    hasAttachments: target.hasAttachments,
  };
  metadata = { ...metadata, replyTo };
  if (input.replyMention !== false && target.authorId !== authorUserId) {
    replyMentions.push(target.authorId);
  }
  return { metadata, replyMentions };
}

/**
 * Classify one `<@…>` token body by prefix:
 *   userId             → user mention (raw userId)
 *   userId:DisplayName → user mention (keep userId, drop label)
 *   type:id|Label      → entity reference (stored as "entity:type:id")
 */
function classifyMentionToken(body: string): string {
  const colonIdx = body.indexOf(':');
  if (colonIdx === -1) return body;
  const prefix = body.slice(0, colonIdx);
  if (!SEARCH_ENTITY_TYPES_SET.has(prefix)) return prefix;
  const rest = body.slice(colonIdx + 1);
  const pipeIdx = rest.indexOf('|');
  const entId = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
  return entId ? `entity:${prefix}:${entId}` : prefix;
}

function extractContentMentions(content: string): string[] {
  const contentMentions: string[] = [];
  const mentionRegex = /<@([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(content)) !== null) {
    const mentionId = classifyMentionToken(match[1]);
    if (!contentMentions.includes(mentionId)) contentMentions.push(mentionId);
  }
  return contentMentions;
}

/** What the post-insert notification / realtime steps of a send share. */
interface SendEffects {
  ctx: PostChatMessageContext;
  rt: RealtimePublisher | null;
  authorName: string;
  messageId: string;
  preview: string;
}

/** Bump the parent's thread counters, then notify every other thread participant. */
async function notifyThreadReply(fx: SendEffects, parentId: string, now: Date): Promise<void> {
  const { db, env, orgId, channelId, authorUserId } = fx.ctx;
  const { rt, authorName, messageId, preview } = fx;
  const { chatMessages } = schema;

  const [parent] = await db
    .select({
      threadParticipantIds: chatMessages.threadParticipantIds,
      authorId: chatMessages.authorId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, parentId))
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
    .where(eq(chatMessages.id, parentId));

  for (const participantId of participants) {
    if (participantId === authorUserId) continue;
    if (rt) {
      try {
        await rt.chatUserThreadReply(orgId, participantId, {
          channelId,
          parentMessageId: parentId,
          replyMessageId: messageId,
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
        parentMessageId: parentId,
        replyMessageId: messageId,
        preview,
      });
    } catch (e) {
      console.error('[app-api/chat] thread reply notification failed:', e);
    }
  }
}

/**
 * Direct-message push: a DM always notifies the other member(s) with the
 * message preview (subject to their notification prefs). Top-level only —
 * thread replies are already covered by the thread-participant notifications.
 * Recipients already mention-notified are skipped to avoid a double ping.
 * Mirrors the platform behaviour so notifications fire regardless of which
 * send endpoint the client uses.
 */
async function notifyDmRecipients(fx: SendEffects, allMentions: string[]): Promise<void> {
  const { db, env, orgId, channelId, authorUserId } = fx.ctx;
  const { chatChannels, chatChannelMembers } = schema;
  try {
    const [channel] = await db
      .select({ type: chatChannels.type })
      .from(chatChannels)
      .where(eq(chatChannels.id, channelId))
      .limit(1);
    if (channel?.type !== 'dm') return;
    const dmMembers = await db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));
    for (const m of dmMembers) {
      if (m.userId === authorUserId || allMentions.includes(m.userId)) continue;
      if (m.userId.startsWith('agt_')) continue;
      try {
        await sendChatDmNotification({
          db,
          env,
          workspaceId: orgId,
          recipientUserId: m.userId,
          senderUserId: authorUserId,
          senderName: fx.authorName,
          channelId,
          preview: fx.preview,
        });
      } catch (e) {
        console.error('[app-api/chat] DM notification failed:', e);
      }
    }
  } catch (e) {
    console.error('[app-api/chat] DM notification lookup failed:', e);
  }
}

/** Whether a mention token refers to a human user who should be notified. */
function isNotifiableMention(mentionedUserId: string, authorUserId: string): boolean {
  if (mentionedUserId === authorUserId || mentionedUserId === 'everyone') return false;
  // Skip entity tags — stored for future search/notification partitioning
  // but do NOT trigger user-mention notifications today.
  if (mentionedUserId.startsWith('entity:')) return false;
  // Agents are not human recipients — room dispatch handles their replies.
  return !mentionedUserId.startsWith('agt_');
}

/** Unread-mention counter, realtime ping and notification for each mentioned user. */
async function notifyMentionedUsers(fx: SendEffects, allMentions: string[]): Promise<void> {
  const { db, env, orgId, channelId, authorUserId } = fx.ctx;
  const { rt, authorName, messageId, preview } = fx;
  const { chatChannelMembers } = schema;

  for (const mentionedUserId of allMentions) {
    if (!isNotifiableMention(mentionedUserId, authorUserId)) continue;

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
        await rt.chatUserMention(orgId, mentionedUserId, { channelId, messageId, authorName, preview });
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
        messageId,
        preview,
      });
    } catch (e) {
      console.error('[app-api/chat] mention notification failed:', e);
    }
  }
}

/** Tell every other human channel member their unread count moved. */
async function fanOutUnreadUpdates(ctx: PostChatMessageContext, rt: RealtimePublisher): Promise<void> {
  const { db, orgId, channelId, authorUserId } = ctx;
  const { chatChannelMembers } = schema;
  try {
    const members = await db
      .select({ userId: chatChannelMembers.userId, memberType: chatChannelMembers.memberType })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));

    for (const member of members) {
      if (member.userId === authorUserId) continue;
      if (member.memberType === 'agent') continue;
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

/** Multi-agent room replies: @mentions and/or always-on policy. */
async function dispatchAgentRoomReplies(
  ctx: PostChatMessageContext,
  messageId: string,
  content: string,
  allMentions: string[],
): Promise<void> {
  const { db, env, orgId, channelId, authorUserId } = ctx;
  const { chatChannels } = schema;
  const agentMentionIds = allMentions.filter((m) => m.startsWith('agt_'));
  const [channelMeta] = await db
    .select({ metadata: chatChannels.metadata })
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);
  const policy = parseAgentRoomPolicy(channelMeta?.metadata as Record<string, unknown> | null);
  const shouldDispatch =
    policy.agentReplyPolicy !== 'none' &&
    (agentMentionIds.length > 0 || policy.agentReplyPolicy === 'always');
  if (!shouldDispatch) return;

  // Durable job: agent replies (tool loops) outlive the ~30s waitUntil budget.
  const job = enqueueWeldAgentJob(
    env,
    ctx.waitUntil ?? ((p) => void p.catch(() => undefined)),
    {
      kind: 'chat-room',
      workspaceId: orgId,
      invokerUserId: authorUserId,
      agentMentionIds,
      channelId,
      messageId,
      messageContent: content,
    },
    db as never,
  ).catch((e) => console.error('[app-api/chat] agent mention dispatch failed:', e));
  if (ctx.waitUntil) ctx.waitUntil(job);
}

export async function postChatMessage(
  ctx: PostChatMessageContext,
  input: PostChatMessageInput,
): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, env, channelId, authorUserId } = ctx;
  const { chatMessages, chatChannels, chatChannelMembers, workspaceMembers } = schema;
  const rt = getPublisher(env);

  await assertChannelAllowsSend(db, channelId, authorUserId, input);

  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, authorUserId))
    .limit(1);
  const authorName = author?.name ?? 'Unknown';

  const { metadata, replyMentions } = await resolveInlineReply(db, channelId, authorUserId, input);

  const id = generateId('msg');
  const now = new Date();
  const hasAttachments = !!(input.attachments && input.attachments.length > 0);

  const contentMentions = extractContentMentions(input.content);
  const allMentions = Array.from(
    new Set([...(input.mentions ?? []), ...contentMentions, ...replyMentions]),
  );
  const mentionsEveryone = allMentions.includes('everyone');

  await db.insert(chatMessages).values({
    id,
    channelId,
    authorId: authorUserId,
    authorName,
    authorAvatar: author?.picture ?? null,
    content: input.content,
    htmlContent: input.htmlContent,
    parentId: input.parentId,
    attachments: input.attachments as never,
    hasAttachments,
    mentions: allMentions.length > 0 ? allMentions : null,
    mentionsEveryone,
    metadata,
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

  const fx: SendEffects = { ctx, rt, authorName, messageId: id, preview };

  if (input.parentId) {
    await notifyThreadReply(fx, input.parentId, now);
  }

  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);

  if (rt) {
    try {
      await rt.chatMessage(channelId, {
        id,
        content: input.content,
        senderId: authorUserId,
        senderName: authorName,
        senderAvatar: author?.picture ?? undefined,
        authorType: 'user',
        threadId: input.parentId ?? undefined,
        replyTo: readReplyReference(metadata) ?? undefined,
      });
    } catch (e) {
      console.error('[app-api/chat] message realtime publish failed:', e);
    }
  }

  if (!input.parentId) {
    await notifyDmRecipients(fx, allMentions);
  }

  await notifyMentionedUsers(fx, allMentions);

  if (rt) {
    await fanOutUnreadUpdates(ctx, rt);
  }

  await dispatchAgentRoomReplies(ctx, id, input.content, allMentions);

  return message;
}

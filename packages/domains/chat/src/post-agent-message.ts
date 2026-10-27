/**
 * Insert a WeldChat message authored by a workspace agent.
 *
 * Separate from `postChatMessage` (human path) so we never accidentally
 * attribute agent replies to a workspace member or spam human push for
 * agent→agent hops. Mention chaining is the caller's job (see
 * `dispatchAgentRoomReplies`). People the reply is for (`notifyUserIds`) and
 * people it mentions are notified like a human mention, but only room members:
 * an agent cannot ping someone about a room they are not in.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  sendChatAgentReplyNotification,
  sendChatMentionNotification,
  stripMarkdown,
} from '@weldsuite/notifications';
import type { NotificationEnv } from '@weldsuite/notifications/types';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { buildMessagePreview } from './message-preview';
import type { ChatReplyReference } from './reply-reference';

/**
 * What posting reads from the worker env: the realtime binding for the live
 * fan-out, plus the (all optional) notification bindings for mentions.
 */
export type PostAgentMessageEnv = NotificationEnv;

export interface PostAgentChatMessageInput {
  content: string;
  parentId?: string | null;
  mentions?: string[];
  /** Loop depth of this reply (0 = direct response to a human). */
  hop?: number;
  metadata?: Record<string, unknown>;
  /** The message this answers, quoted above the reply (`metadata.replyTo`). */
  replyTo?: ChatReplyReference | null;
  /**
   * People to notify as if mentioned, typically whoever asked the agent. They
   * are added to `mentions` (so the reply is highlighted for them) without a
   * visible `<@…>` token.
   */
  notifyUserIds?: string[];
}

export interface PostAgentChatMessageContext {
  db: Database;
  env: PostAgentMessageEnv;
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

function getPublisher(env: PostAgentMessageEnv): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET }) : null;
}

/** How often the "working…" signal is repeated; clients drop it after 6s without one. */
export const AGENT_WORKING_HEARTBEAT_MS = 4_000;

/**
 * Show "<agent> is working…" in the room while a background turn runs.
 *
 * Rides the room's typing event (`agt_*` ids tell clients it is an agent), so
 * every client that shows typing shows it. Clients forget a typing entry after
 * 6s, so it is repeated until the returned `stop` is called. Best effort:
 * without a realtime binding it does nothing, and publish failures are ignored.
 */
export function startAgentWorkingIndicator(
  env: PostAgentMessageEnv,
  channelId: string,
  agent: { id: string; name: string },
  heartbeatMs = AGENT_WORKING_HEARTBEAT_MS,
): () => Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return async () => {};
  const publish = (isTyping: boolean) =>
    rt
      .chatPublish(channelId, { type: 'typing', userId: agent.id, userName: agent.name, isTyping })
      .catch(() => undefined);

  void publish(true);
  const timer = setInterval(() => void publish(true), heartbeatMs);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await publish(false);
  };
}

interface RoomMember {
  userId: string;
  memberType: string | null;
}

/** The room's roster; empty (and logged) when the lookup fails. */
async function loadRoomMembers(db: Database, channelId: string): Promise<RoomMember[]> {
  const { chatChannelMembers } = schema;
  try {
    return await db
      .select({ userId: chatChannelMembers.userId, memberType: chatChannelMembers.memberType })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));
  } catch (e) {
    console.error('[chat-domain] agent message roster lookup failed:', e);
    return [];
  }
}

/** Mention ids that point at a person (not an agent, `everyone` or a record). */
function isPersonMention(id: string): boolean {
  return id !== 'everyone' && !id.startsWith('agt_') && !id.startsWith('entity:');
}

/**
 * Unread-mention counter, realtime ping and notification for each person the
 * reply mentions or is for. Room members only; failures are logged, never thrown.
 * People the reply is only for (`replyTo`: they asked, nobody wrote their
 * name) hear "<agent> replied to you"; people it names hear "mentioned you".
 */
async function notifyMentionedPeople(
  rt: RealtimePublisher | null,
  ctx: PostAgentChatMessageContext,
  members: RoomMember[],
  message: { messageId: string; preview: string; mentions: string[]; replyTo: ReadonlySet<string> },
): Promise<void> {
  const { db, env, orgId, channelId, agentId, agentName } = ctx;
  const { chatChannelMembers } = schema;
  const people = new Set(members.filter((m) => m.memberType !== 'agent').map((m) => m.userId));
  const recipients = message.mentions.filter((id) => isPersonMention(id) && people.has(id));
  if (recipients.length === 0) return;

  try {
    await db
      .update(chatChannelMembers)
      .set({ unreadMentionCount: sql`${chatChannelMembers.unreadMentionCount} + 1` })
      .where(and(eq(chatChannelMembers.channelId, channelId), inArray(chatChannelMembers.userId, recipients)));
  } catch (e) {
    console.error('[chat-domain] agent mention count increment failed:', e);
  }

  await Promise.all(
    recipients.map(async (userId) => {
      try {
        await rt?.chatUserMention(orgId, userId, {
          channelId,
          messageId: message.messageId,
          authorName: agentName,
          preview: message.preview,
        });
      } catch (e) {
        console.error('[chat-domain] agent mention realtime publish failed:', e);
      }
      try {
        if (message.replyTo.has(userId)) {
          await sendChatAgentReplyNotification({
            db: db as never,
            env,
            workspaceId: orgId,
            recipientUserId: userId,
            agentId,
            agentName,
            channelId,
            messageId: message.messageId,
            preview: message.preview,
          });
        } else {
          await sendChatMentionNotification({
            db: db as never,
            env,
            workspaceId: orgId,
            mentionedUserId: userId,
            authorUserId: agentId,
            authorName: agentName,
            channelId,
            messageId: message.messageId,
            preview: message.preview,
          });
        }
      } catch (e) {
        console.error('[chat-domain] agent mention notification failed:', e);
      }
    }),
  );
}

/** Realtime message event plus per-member unread bumps; failures are logged, never thrown. */
async function publishAgentMessageRealtime(
  rt: RealtimePublisher,
  ctx: PostAgentChatMessageContext,
  members: RoomMember[],
  message: { id: string; content: string; parentId?: string | null; replyTo?: ChatReplyReference },
): Promise<void> {
  const { orgId, channelId, agentId, agentName, agentIcon } = ctx;

  try {
    await rt.chatMessage(channelId, {
      id: message.id,
      content: message.content,
      senderId: agentId,
      senderName: agentName,
      senderAvatar: agentIcon ?? undefined,
      authorType: 'agent',
      threadId: message.parentId ?? undefined,
      replyTo: message.replyTo,
    });
  } catch (e) {
    console.error('[app-api/chat] agent message realtime publish failed:', e);
  }

  await Promise.all(
    members
      .filter((member) => member.memberType !== 'agent' && member.userId !== agentId)
      .map(async (member) => {
        try {
          await rt.chatUserUnreadUpdate(orgId, member.userId, { channelId, unreadCount: 1 });
        } catch {
          /* non-critical */
        }
      }),
  );
}

export async function postAgentChatMessage(
  ctx: PostAgentChatMessageContext,
  input: PostAgentChatMessageInput,
): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, env, channelId, agentId, agentName, agentIcon, invokerUserId } = ctx;
  const { chatMessages, chatChannels } = schema;
  const rt = getPublisher(env);

  const id = generateId('msg');
  const now = new Date();
  const hop = input.hop ?? 0;
  const namedMentions = extractChatMentions(input.content, input.mentions ?? []);
  const allMentions = extractChatMentions(input.content, [
    ...(input.mentions ?? []),
    ...(input.notifyUserIds ?? []),
  ]);
  // Asked, but not named: these hear "replied to you", not "mentioned you".
  const replyTo = new Set((input.notifyUserIds ?? []).filter((userId) => !namedMentions.includes(userId)));

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
      ...input.metadata,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      agentHop: hop,
      invokerUserId,
    },
    createdAt: now,
    updatedAt: now,
  });

  // Agents write markdown; the room list and notifications show plain text.
  const preview = await buildMessagePreview(db, stripMarkdown(input.content));
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

  const members = await loadRoomMembers(db, channelId);
  if (rt) {
    await publishAgentMessageRealtime(rt, ctx, members, {
      id,
      content: input.content,
      parentId: input.parentId,
      replyTo: input.replyTo ?? undefined,
    });
  }
  await notifyMentionedPeople(rt, ctx, members, { messageId: id, preview, mentions: allMentions, replyTo });

  return message;
}

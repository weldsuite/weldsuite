/**
 * WeldChat "pinned a message" channel notice.
 *
 * `POST /api/chat-messages/:id/pin` with `notify: true` ("Pin with alert")
 * leaves a visible notice in the channel. The notice is written HERE, on the
 * server, as a `type: 'system'` message authored by the pinning user. It used
 * to be an ordinary client-sent message whose text merely looked like a notice
 * (`[system:<id>] pinned a message`), which any member could forge: the
 * renderer must now only honour that prefix on rows whose `type` is `system`,
 * and `type` can no longer be set through the public create routes.
 *
 * Pure of Hono — takes the tenant `db` and the realtime binding.
 */

import { and, eq, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

type RealtimeBinding = ConstructorParameters<typeof RealtimePublisher>[0];

export interface PinNotice {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
}

/** Exact content of a pin notice; the renderer matches the `[system:<id>]` prefix. */
export function pinNoticeContent(pinnedMessageId: string): string {
  return `[system:${pinnedMessageId}] pinned a message`;
}

/**
 * Insert the notice, move the channel's last-message fields, advance the
 * pinner's own read marker (so their channel does not turn "unread" because of
 * their own notice) and push it to open clients.
 */
export async function postPinNotice(
  db: Database,
  realtime: RealtimeBinding | undefined,
  params: { channelId: string; pinnedMessageId: string; userId: string },
): Promise<PinNotice> {
  const { chatMessages, chatChannels, chatChannelMembers, workspaceMembers } = schema;
  const { channelId, pinnedMessageId, userId } = params;

  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  const authorName = author?.name ?? 'Unknown';

  const id = generateId('msg');
  const now = new Date();
  const content = pinNoticeContent(pinnedMessageId);

  await db.insert(chatMessages).values({
    id,
    channelId,
    authorId: userId,
    authorName,
    authorAvatar: author?.picture ?? null,
    content,
    type: 'system',
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(chatChannels)
    .set({
      lastMessageAt: now,
      lastMessagePreview: `${authorName} pinned a message`,
      messageCount: sql`${chatChannels.messageCount} + 1`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  await db
    .update(chatChannelMembers)
    .set({ lastReadAt: now, lastReadMessageId: id })
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)));

  if (realtime) {
    try {
      // `chatMessage()` has no field for the message type (and clients default
      // it to a plain message), so publish the same `message` event with an
      // explicit `messageType`.
      await new RealtimePublisher(realtime).chatPublish(channelId, {
        type: 'message',
        id,
        content,
        senderId: userId,
        senderName: authorName,
        senderAvatar: author?.picture ?? undefined,
        authorType: 'user',
        messageType: 'system',
        ts: Date.now(),
      });
    } catch (e) {
      console.error('[chat-api/chat-messages] pin notice realtime publish failed:', e);
    }
  }

  return { id, channelId, authorId: userId, content };
}

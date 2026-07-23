/**
 * WeldChat channel read-state service (app-api).
 *
 * Ported from the obsolete api-worker `routes/chat/channels.ts` (W5b
 * legacy-worker phase-out). Two coupled pieces of behaviour the flat app-api
 * read route dropped:
 *
 *   - marking a channel read writes a per-message `chatMessageReads` row for
 *     every unread message, not just the member cursor. The "seen by" avatars
 *     read those rows, so without the bulk insert the read-receipt surface is
 *     permanently empty.
 *   - `beforeMessageId` ("mark unread from here") — see markChannelUnreadFrom.
 *
 * Pure functions (no Hono context): realtime publishing stays with the route.
 */

import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { chatChannelMembers, chatMessages, chatMessageReads, workspaceMembers } = schema;

export interface MarkReadResult {
  channelId: string;
  lastReadAt: Date;
  lastReadMessageId: string | null;
}

/**
 * Mark every message in the channel read for `userId`.
 *
 * Inserts the per-message read records in batches of 100 (a Neon HTTP request
 * carrying thousands of rows in one statement is a timeout risk) and resets the
 * mention counter.
 */
export async function markChannelRead(
  db: Database,
  channelId: string,
  userId: string,
): Promise<MarkReadResult> {
  const allMessages = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), isNull(chatMessages.deletedAt)))
    .orderBy(desc(chatMessages.createdAt));

  const existingReads = await db
    .select({ messageId: chatMessageReads.messageId })
    .from(chatMessageReads)
    .where(and(eq(chatMessageReads.channelId, channelId), eq(chatMessageReads.userId, userId)));

  const alreadyRead = new Set(existingReads.map((r) => r.messageId));
  const unread = allMessages.filter((m) => !alreadyRead.has(m.id));

  const now = new Date();
  const latestMessageId = allMessages[0]?.id ?? null;

  if (unread.length > 0) {
    const values = unread.map((msg) => ({
      id: generateId('cmr'),
      messageId: msg.id,
      channelId,
      userId,
      readAt: now,
    }));
    for (let i = 0; i < values.length; i += 100) {
      await db.insert(chatMessageReads).values(values.slice(i, i + 100)).onConflictDoNothing();
    }
  }

  await db
    .update(chatChannelMembers)
    .set({ lastReadAt: now, lastReadMessageId: latestMessageId, unreadMentionCount: 0 })
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)));

  return { channelId, lastReadAt: now, lastReadMessageId: latestMessageId };
}

/**
 * "Mark unread from here": everything from `beforeMessageId` onwards becomes
 * unread again, and the read cursor rewinds to the message immediately before
 * it.
 *
 * Behaviour note (deliberate, flagged in the W5b report): the legacy handler
 * accepted this body and then ignored it — `POST /chat/channels/:id/read` never
 * read `beforeMessageId`, so the platform's "Mark unread from here" action has
 * been marking the channel fully READ, the exact opposite of what the user
 * asked. This implements the semantics the caller always intended.
 *
 * Returns null when the anchor message does not belong to the channel.
 */
export async function markChannelUnreadFrom(
  db: Database,
  channelId: string,
  userId: string,
  beforeMessageId: string,
): Promise<MarkReadResult | null> {
  const [anchor] = await db
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, beforeMessageId), eq(chatMessages.channelId, channelId)))
    .limit(1);

  if (!anchor) return null;

  // Drop the read records for the anchor and everything newer.
  const toUnread = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), gte(chatMessages.createdAt, anchor.createdAt)));

  const unreadIds = toUnread.map((m) => m.id);
  for (let i = 0; i < unreadIds.length; i += 100) {
    const batch = unreadIds.slice(i, i + 100);
    if (batch.length === 0) continue;
    await db
      .delete(chatMessageReads)
      .where(
        and(
          eq(chatMessageReads.channelId, channelId),
          eq(chatMessageReads.userId, userId),
          inArray(chatMessageReads.messageId, batch),
        ),
      );
  }

  // Rewind the cursor to the newest surviving message older than the anchor.
  const [previous] = await db
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channelId, channelId),
        isNull(chatMessages.deletedAt),
        lt(chatMessages.createdAt, anchor.createdAt),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  const lastReadAt = previous?.createdAt ?? new Date(anchor.createdAt.getTime() - 1);

  await db
    .update(chatChannelMembers)
    .set({ lastReadAt, lastReadMessageId: previous?.id ?? null })
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)));

  return { channelId, lastReadAt, lastReadMessageId: previous?.id ?? null };
}

export interface ReadReceipt {
  userId: string;
  userName: string | null;
  userAvatar: string | null;
  readAt: Date | null;
}

/**
 * Per-message read data for a channel, grouped by messageId — the exact
 * `{ [messageId]: readers[] }` shape the platform's useReadReceipts consumers
 * index by.
 */
export async function getChannelReadReceipts(
  db: Database,
  channelId: string,
): Promise<Record<string, ReadReceipt[]>> {
  const receipts = await db
    .select({
      messageId: chatMessageReads.messageId,
      userId: chatMessageReads.userId,
      readAt: chatMessageReads.readAt,
      userName: workspaceMembers.name,
      userAvatar: workspaceMembers.picture,
    })
    .from(chatMessageReads)
    .leftJoin(workspaceMembers, eq(chatMessageReads.userId, workspaceMembers.userId))
    .where(eq(chatMessageReads.channelId, channelId))
    .orderBy(desc(chatMessageReads.readAt));

  const grouped: Record<string, ReadReceipt[]> = {};
  for (const r of receipts) {
    if (!grouped[r.messageId]) grouped[r.messageId] = [];
    grouped[r.messageId].push({
      userId: r.userId,
      userName: r.userName,
      userAvatar: r.userAvatar,
      readAt: r.readAt,
    });
  }
  return grouped;
}

/** Display name + avatar for a read-receipt broadcast. */
export async function getReaderProfile(
  db: Database,
  userId: string,
): Promise<{ name: string; avatar?: string }> {
  const [row] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  return { name: row?.name ?? '', avatar: row?.picture ?? undefined };
}

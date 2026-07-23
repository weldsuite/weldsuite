/**
 * WeldChat message-forward service (app-api).
 *
 * Ported from the obsolete api-worker `routes/chat/messages.ts`
 * `POST /:messageId/forward` (W5b legacy-worker phase-out). Lives under the
 * channels surface because that is where the legacy route was mounted:
 * `/chat/channels/:channelId/messages/:messageId/forward`.
 *
 * Not expressible as N calls to postChatMessage: a forward carries a
 * `forwardedFrom` snapshot, derives its preview from the snapshot when there is
 * no comment, must validate + auto-join every target up front (all-or-nothing),
 * and never re-fires the source message's mentions.
 *
 * Pure functions (no Hono context): realtime publishing stays with the route.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { chatMessages, chatChannels, chatChannelMembers, workspaceMembers } = schema;

export interface ForwardMessageInput {
  targetChannelIds: string[];
  comment?: string;
  htmlComment?: string;
}

export interface ForwardedMessage {
  channelId: string;
  messageId: string;
  /** Everyone in the target channel except the forwarder — for unread fan-out. */
  recipientUserIds: string[];
  content: string;
  htmlContent?: string;
  forwardedFrom: NonNullable<typeof chatMessages.$inferSelect['forwardedFrom']>;
}

export type ForwardMessageResult =
  | { ok: true; forwarded: ForwardedMessage[]; authorName: string; authorAvatar: string | null }
  | { ok: false; status: 403 | 404; message: string };

export async function forwardMessage(
  db: Database,
  params: { sourceChannelId: string; sourceMessageId: string; userId: string },
  input: ForwardMessageInput,
): Promise<ForwardMessageResult> {
  const { sourceChannelId, sourceMessageId, userId } = params;

  // The forwarder must be a member of the SOURCE channel — membership, not
  // `channels:read`, is what gates access to a private channel's content.
  const [sourceMembership] = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, sourceChannelId), eq(chatChannelMembers.userId, userId)),
    )
    .limit(1);
  if (!sourceMembership) {
    return { ok: false, status: 403, message: 'You do not have access to this message' };
  }

  const [source] = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, sourceMessageId),
        eq(chatMessages.channelId, sourceChannelId),
        isNull(chatMessages.deletedAt),
      ),
    )
    .limit(1);
  if (!source) return { ok: false, status: 404, message: 'Message not found' };

  const [sourceChannel] = await db
    .select({ id: chatChannels.id, name: chatChannels.name, type: chatChannels.type })
    .from(chatChannels)
    .where(eq(chatChannels.id, sourceChannelId))
    .limit(1);

  // Forwarding a forward points at the ORIGINAL, never the intermediate hop
  // (matches Slack/Teams).
  const forwardedFrom: NonNullable<typeof source.forwardedFrom> = source.forwardedFrom ?? {
    messageId: source.id,
    channelId: source.channelId,
    channelName: sourceChannel?.name ?? 'channel',
    channelType: (sourceChannel?.type as 'public' | 'private' | 'dm' | undefined) ?? 'public',
    authorId: source.authorId,
    authorName: source.authorName,
    authorAvatar: source.authorAvatar ?? undefined,
    content: source.content,
    htmlContent: source.htmlContent ?? undefined,
    createdAt: source.createdAt.toISOString(),
    attachments: source.attachments ?? undefined,
  };

  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  const authorName = author?.name ?? 'Unknown';
  const authorAvatar = author?.picture ?? null;

  const uniqueTargets = Array.from(new Set(input.targetChannelIds));
  if (uniqueTargets.length === 0) {
    return { ok: true, forwarded: [], authorName, authorAvatar };
  }

  // Validate every target up front — reject the whole request rather than
  // partially forwarding.
  const targetChannels = await db
    .select({ id: chatChannels.id, type: chatChannels.type })
    .from(chatChannels)
    .where(and(inArray(chatChannels.id, uniqueTargets), isNull(chatChannels.deletedAt)));
  const channelById = new Map(targetChannels.map((ch) => [ch.id, ch]));
  const missing = uniqueTargets.filter((id) => !channelById.has(id));
  if (missing.length > 0) {
    return { ok: false, status: 404, message: `Channel(s) not found: ${missing.join(', ')}` };
  }

  const nonPublicTargets = uniqueTargets.filter((id) => channelById.get(id)!.type !== 'public');
  const memberSet = new Set<string>();
  if (nonPublicTargets.length > 0) {
    const memberships = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.userId, userId),
          inArray(chatChannelMembers.channelId, nonPublicTargets),
        ),
      );
    for (const m of memberships) memberSet.add(m.channelId);
  }
  const inaccessible = nonPublicTargets.filter((id) => !memberSet.has(id));
  if (inaccessible.length > 0) {
    return {
      ok: false,
      status: 403,
      message: `You are not a member of ${inaccessible.length} target channel(s)`,
    };
  }

  // Auto-join the forwarder to public targets they haven't joined, so the
  // forwarded message lands in their sidebar and unread tracking works.
  const publicTargets = uniqueTargets.filter((id) => channelById.get(id)!.type === 'public');
  if (publicTargets.length > 0) {
    const existing = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.userId, userId),
          inArray(chatChannelMembers.channelId, publicTargets),
        ),
      );
    const joined = new Set(existing.map((r) => r.channelId));
    const joinedAt = new Date();
    for (const channelId of publicTargets) {
      if (joined.has(channelId)) continue;
      await db
        .insert(chatChannelMembers)
        .values({
          id: generateId('cmb'),
          channelId,
          userId,
          role: 'member',
          joinedAt,
          createdAt: joinedAt,
        })
        .onConflictDoNothing();
      await db
        .update(chatChannels)
        .set({ memberCount: sql`${chatChannels.memberCount} + 1`, updatedAt: joinedAt })
        .where(eq(chatChannels.id, channelId));
    }
  }

  const forwardedContent = input.comment?.trim() ?? '';
  const forwarded: ForwardedMessage[] = [];
  const now = new Date();

  for (const targetChannelId of uniqueTargets) {
    const id = generateId('msg');

    await db.insert(chatMessages).values({
      id,
      channelId: targetChannelId,
      authorId: userId,
      authorName,
      authorAvatar,
      content: forwardedContent,
      htmlContent: input.htmlComment,
      forwardedFrom,
      // The snapshot carries its own attachments; the new row has none.
      hasAttachments: false,
      createdAt: now,
      updatedAt: now,
    });

    const previewSource = forwardedContent || `Forwarded: ${forwardedFrom.content}`;
    const preview =
      previewSource.length > 100 ? previewSource.slice(0, 100) + '...' : previewSource;
    await db
      .update(chatChannels)
      .set({
        lastMessageAt: now,
        lastMessagePreview: preview,
        messageCount: sql`${chatChannels.messageCount} + 1`,
        updatedAt: now,
      })
      .where(eq(chatChannels.id, targetChannelId));

    const members = await db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, targetChannelId));

    forwarded.push({
      channelId: targetChannelId,
      messageId: id,
      recipientUserIds: members.map((m) => m.userId).filter((uid) => uid !== userId),
      content: forwardedContent,
      htmlContent: input.htmlComment,
      forwardedFrom,
    });
  }

  return { ok: true, forwarded, authorName, authorAvatar };
}

/**
 * Entity-linked chat channels — minimal helpers used by the per-object
 * chat sub-routes (e.g. /api/companies/:id/chat, /api/people/:id/chat).
 *
 * No registry: each object route knows which DB table to read and passes
 * the resolved `displayName` + `defaultMemberIds` directly. The helpers
 * here just lazily create the `chatChannels` row + membership rows and
 * insert the first message.
 *
 * Realtime + mention/thread notifications are intentionally omitted
 * from this worker for now. The legacy api-worker pipeline still handles
 * those for messages posted to existing channels via the chat-messages
 * route. Follow-up: port the realtime publisher into app-api.
 */

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import { generateId } from './id';

export interface EntityChannelInfo {
  displayName: string;
  defaultMemberIds: string[];
  icon?: string | null;
}

function slugify(input: string, suffix: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
  return `${base || 'entity'}-${suffix}`.slice(0, 255);
}

export async function findEntityChannel(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<typeof schema.chatChannels.$inferSelect | null> {
  const { chatChannels } = schema;
  const [row] = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        isNull(chatChannels.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Find a SOFT-DELETED entity channel for this entity, if one exists. Deleting
 * an entity channel only sets `deletedAt` and keeps the (entityType, entityId)
 * link, so a deleted row still occupies the entity's slot — resurrect it rather
 * than inserting a duplicate. Returns the most recently deleted match.
 */
export async function findDeletedEntityChannel(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<typeof schema.chatChannels.$inferSelect | null> {
  const { chatChannels } = schema;
  const [row] = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        isNotNull(chatChannels.deletedAt),
      ),
    )
    .orderBy(desc(chatChannels.deletedAt))
    .limit(1);
  return row ?? null;
}

async function resurrectEntityChannel(
  db: Database,
  channelId: string,
  info: EntityChannelInfo,
  actingUserId: string,
): Promise<typeof schema.chatChannels.$inferSelect> {
  const { chatChannels, chatChannelMembers } = schema;
  const now = new Date();

  const memberIds = new Set<string>(info.defaultMemberIds.filter(Boolean));
  memberIds.add(actingUserId);
  for (const userId of memberIds) {
    try {
      await db.insert(chatChannelMembers).values({
        id: generateId('cmb'),
        channelId,
        userId,
        role: userId === actingUserId ? 'owner' : 'member',
        joinedAt: now,
        createdAt: now,
      });
    } catch {
      // Already a member — ignore.
    }
  }

  const currentMembers = await db
    .select({ id: chatChannelMembers.id })
    .from(chatChannelMembers)
    .where(eq(chatChannelMembers.channelId, channelId));

  await db
    .update(chatChannels)
    .set({
      deletedAt: null,
      name: info.displayName,
      entityDisplayName: info.displayName,
      icon: info.icon ?? null,
      memberCount: currentMembers.length,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);
  return channel!;
}

export async function getOrCreateEntityChannel(params: {
  db: Database;
  entityType: string;
  entityId: string;
  actingUserId: string;
  info: EntityChannelInfo;
}): Promise<{ channel: typeof schema.chatChannels.$inferSelect; created: boolean }> {
  const { db, entityType, entityId, actingUserId, info } = params;

  const existing = await findEntityChannel(db, entityType, entityId);
  if (existing) return { channel: existing, created: false };

  // A previously-deleted channel still holds this entity's slot (soft delete
  // keeps the link). Revive it instead of spawning a duplicate.
  const deleted = await findDeletedEntityChannel(db, entityType, entityId);
  if (deleted) {
    const channel = await resurrectEntityChannel(db, deleted.id, info, actingUserId);
    return { channel, created: false };
  }

  const { chatChannels, chatChannelMembers } = schema;
  const channelId = generateId('ch');
  const now = new Date();

  const memberIds = new Set<string>(info.defaultMemberIds.filter(Boolean));
  memberIds.add(actingUserId);

  try {
    await db.insert(chatChannels).values({
      id: channelId,
      name: info.displayName,
      slug: slugify(info.displayName, channelId),
      type: 'entity',
      entityType,
      entityId,
      entityDisplayName: info.displayName,
      icon: info.icon ?? null,
      createdBy: actingUserId,
      memberCount: memberIds.size,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Collision — reuse the live row, else resurrect a soft-deleted one.
    const retry = await findEntityChannel(db, entityType, entityId);
    if (retry) return { channel: retry, created: false };
    const retryDeleted = await findDeletedEntityChannel(db, entityType, entityId);
    if (retryDeleted) {
      const channel = await resurrectEntityChannel(db, retryDeleted.id, info, actingUserId);
      return { channel, created: false };
    }
    throw err;
  }

  for (const userId of memberIds) {
    try {
      await db.insert(chatChannelMembers).values({
        id: generateId('cmb'),
        channelId,
        userId,
        role: userId === actingUserId ? 'owner' : 'member',
        joinedAt: now,
        createdAt: now,
      });
    } catch {
      // Duplicate membership — ignore.
    }
  }

  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);

  return { channel: channel!, created: true };
}

export interface PostEntityMessageInput {
  content: string;
  htmlContent?: string;
  parentId?: string;
  attachments?: Array<Record<string, unknown>>;
  mentions?: string[];
  mentionsEveryone?: boolean;
  metadata?: Record<string, unknown>;
}

export async function postChannelMessage(params: {
  db: Database;
  channelId: string;
  authorUserId: string;
  input: PostEntityMessageInput;
}): Promise<typeof schema.chatMessages.$inferSelect> {
  const { db, channelId, authorUserId, input } = params;
  const { chatMessages, chatChannels, workspaceMembers } = schema;

  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, authorUserId))
    .limit(1);

  const id = generateId('msg');
  const now = new Date();
  const hasAttachments = !!(input.attachments && input.attachments.length > 0);
  const mentions = input.mentions && input.mentions.length > 0 ? input.mentions : null;
  const mentionsEveryone = input.mentionsEveryone ?? (mentions?.includes('everyone') ?? false);

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
    mentions,
    mentionsEveryone,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  });

  const preview =
    input.content.length > 100 ? input.content.slice(0, 100) + '...' : input.content;
  await db
    .update(chatChannels)
    .set({
      lastMessageAt: now,
      lastMessagePreview: preview,
      messageCount: sql`${chatChannels.messageCount} + 1`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  const [message] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, id))
    .limit(1);
  return message!;
}

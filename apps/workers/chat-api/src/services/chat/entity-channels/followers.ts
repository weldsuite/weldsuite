/**
 * Following a record chat.
 *
 * Following is a `chat_channel_members` row, nothing more: it puts the chat in
 * the user's WeldChat sidebar and drives their unread state and notifications.
 * Who may READ a record chat is the provider's business (canAccessEntity), not
 * this row's. New followers get a `channel_new` push on their user topic so the
 * chat shows up in their sidebar without a refresh.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { publishChatUserChannelNew, type WeldChatPublisherEnv } from '@weldsuite/chat-domain/realtime/weldchat-publisher';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  canAccessEntity,
  getEntityProvider,
  userPermissionCheck,
} from '@weldsuite/chat-domain/entity-channels';

const { chatChannels, chatChannelMembers } = schema;

/** Re-count `memberCount` from the membership rows. */
async function syncMemberCount(db: Database, channelId: string): Promise<void> {
  await db
    .update(chatChannels)
    .set({
      memberCount: sql`(SELECT count(*)::int FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${channelId})`,
    })
    .where(eq(chatChannels.id, channelId));
}

/**
 * Make each of `userIds` follow the channel. Users who already follow it are
 * left alone. Returns the users who were actually added. `ownerId` (the user
 * who created the channel) is added with the `owner` role.
 */
export async function addFollowers(
  db: Database,
  channelId: string,
  userIds: string[],
  options: { ownerId?: string } = {},
): Promise<string[]> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  if (wanted.length === 0) return [];

  const existing = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, channelId), inArray(chatChannelMembers.userId, wanted)));
  const already = new Set(existing.map((m) => m.userId));
  const missing = wanted.filter((userId) => !already.has(userId));
  if (missing.length === 0) return [];

  const now = new Date();
  // A concurrent request may add the same user between the read and the
  // insert; the unique (channel, user) index turns that into a no-op.
  const inserted = await db
    .insert(chatChannelMembers)
    .values(
      missing.map((userId) => ({
        id: generateId('cmb'),
        channelId,
        userId,
        role: userId === options.ownerId ? 'owner' : 'member',
        joinedAt: now,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ userId: chatChannelMembers.userId });

  if (inserted.length > 0) await syncMemberCount(db, channelId);
  return inserted.map((r) => r.userId);
}

/**
 * Mute / unmute every record chat of one type the caller follows. Backs the
 * sidebar's "Mute all" / "Unmute all" group actions: the sidebar only ever
 * holds a capped slice of a followed group (up to 4 pages of 25 — see the
 * platform's `use-record-chat-groups.ts`), so muting row-by-row from the
 * loaded rows silently left the rest of a long followed list still
 * notifying. One UPDATE reaches every membership row the caller owns for the
 * type, loaded in the sidebar or not. Returns the ids of the channels whose
 * mute state actually changed, so the route can publish one entity event per
 * channel (mirroring the single-channel mute route).
 */
export async function setFollowedChannelsMuted(
  db: Database,
  userId: string,
  entityType: string,
  isMuted: boolean,
): Promise<string[]> {
  const followed = await db
    .select({ channelId: chatChannelMembers.channelId })
    .from(chatChannelMembers)
    .innerJoin(chatChannels, eq(chatChannels.id, chatChannelMembers.channelId))
    .where(
      and(
        eq(chatChannelMembers.userId, userId),
        eq(chatChannelMembers.isMuted, !isMuted),
        eq(chatChannels.type, 'entity'),
        eq(chatChannels.entityType, entityType),
        isNull(chatChannels.deletedAt),
      ),
    );
  const channelIds = followed.map((r) => r.channelId);
  if (channelIds.length === 0) return [];

  await db
    .update(chatChannelMembers)
    .set({ isMuted })
    .where(and(eq(chatChannelMembers.userId, userId), inArray(chatChannelMembers.channelId, channelIds)));

  return channelIds;
}

/** Stop following. Returns false when the user did not follow the channel. */
export async function removeFollower(db: Database, channelId: string, userId: string): Promise<boolean> {
  const removed = await db
    .delete(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)))
    .returning({ id: chatChannelMembers.id });
  if (removed.length === 0) return false;
  await syncMemberCount(db, channelId);
  return true;
}

/**
 * Of a new record chat's default members (owner, account manager, assignees…),
 * the ones who may open the record. A default member who may not (an account
 * manager outside a company's owner scope, say) is left out: following would
 * push a chat with the record's name to someone who cannot open it. The acting
 * user is kept as is, they passed the read check of the route they came through.
 */
export async function defaultFollowersWhoMayOpen(
  db: Database,
  params: { entityType: string; entityId: string; actingUserId: string; userIds: string[] },
): Promise<string[]> {
  const { entityType, entityId, actingUserId } = params;
  const provider = getEntityProvider(entityType);
  const candidates = [...new Set(params.userIds)].filter((id) => id && id !== actingUserId);
  if (!provider || candidates.length === 0) return [];
  const allowed = await Promise.all(
    candidates.map(async (userId) => {
      const ctx = { db, actingUserId: userId, entityId, can: userPermissionCheck(db, userId) };
      return (await canAccessEntity(provider, ctx)) ? userId : null;
    }),
  );
  return allowed.filter((id): id is string => id !== null);
}

/**
 * A message in a record chat makes its author follow the chat, and every
 * @mentioned user who may see the record. A mentioned user who may not see it
 * is left out: following would put a chat in their sidebar that they cannot
 * open. Returns the users who started following.
 */
export async function followRecordChatOnPost(
  db: Database,
  params: {
    channelId: string;
    entityType: string;
    entityId: string;
    authorUserId: string;
    mentionedUserIds: string[];
  },
): Promise<string[]> {
  const { channelId, entityType, entityId, authorUserId } = params;
  const mentioned = [...new Set(params.mentionedUserIds)].filter((id) => id !== authorUserId);

  const following = new Set(
    (
      await db
        .select({ userId: chatChannelMembers.userId })
        .from(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.channelId, channelId),
            inArray(chatChannelMembers.userId, [authorUserId, ...mentioned]),
          ),
        )
    ).map((m) => m.userId),
  );

  // The author already passed the read check of the route they posted through.
  const followers = following.has(authorUserId) ? [] : [authorUserId];
  const provider = getEntityProvider(entityType);
  if (provider) {
    for (const userId of mentioned) {
      if (following.has(userId)) continue;
      const ctx = { db, actingUserId: userId, entityId, can: userPermissionCheck(db, userId) };
      if (await canAccessEntity(provider, ctx)) followers.push(userId);
    }
  }
  return addFollowers(db, channelId, followers);
}

/**
 * Tell each new follower's other sessions that a chat appeared in their
 * sidebar. Best-effort: a failed push only means the sidebar catches up on its
 * next refresh.
 */
export async function announceNewFollowers(
  env: WeldChatPublisherEnv,
  workspaceId: string,
  channel: { id: string; name: string },
  userIds: string[],
): Promise<void> {
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        await publishChatUserChannelNew(env, workspaceId, userId, channel.id, channel.name);
      } catch (e) {
        console.error('[chat-api/entity-channels] channel_new publish failed:', e);
      }
    }),
  );
}

/**
 * WeldChat channel-access service.
 *
 * Pure functions (no Hono context) that enforce the WeldChat read boundary:
 * a user may see a channel (and its messages) when the channel is PUBLIC, or
 * when the caller has a `chatChannelMembers` row for it. Private / DM channels
 * leak nothing to non-members.
 *
 * Record chats (`type = 'entity'`) are the exception: reading one follows
 * access to the record, not membership (ADR CHAT-003). The record type's
 * provider decides, together with the workspace permission for that type
 * (`companies:read`, …). Membership there only means "following".
 *
 * Extracted from chat-api (apps/workers/chat-api/src/services/chat/channel-access.ts,
 * which now just re-exports this module) so connect-api's WeldConnect
 * `post_chat_message` internal route can evaluate the SAME boundary for the
 * workflow's owner, without importing across worker folders.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  canAccessEntity,
  getEntityProvider,
  userPermissionCheck,
  type PermissionCheck,
} from './entity-channels';

const { chatChannels, chatChannelMembers, chatMessages, workspaceMembers } = schema;

export interface ChannelAccessOptions {
  /**
   * The user's permission check, used for record chats. Defaults to resolving
   * the user's permissions from the tenant DB and evaluating them across all
   * apps, with member denies applied.
   */
  can?: PermissionCheck;
}

/**
 * True when the caller may read the given channel — i.e. the channel is a
 * non-deleted public channel, the caller has a membership row for it, or, for
 * a record chat, the caller may see the record.
 *
 * Returns `false` for unknown / soft-deleted channels so callers can answer
 * with a 403 without leaking existence.
 */
export async function canAccessChannel(
  db: Database,
  channelId: string,
  userId: string,
  options: ChannelAccessOptions = {},
): Promise<boolean> {
  const [channel] = await db
    .select({
      id: chatChannels.id,
      type: chatChannels.type,
      entityType: chatChannels.entityType,
      entityId: chatChannels.entityId,
    })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt)))
    .limit(1);

  if (!channel) return false;
  if (channel.type === 'public') return true;
  if (channel.type === 'entity') return canReadRecordChat(db, channel, userId, options.can);

  const [membership] = await db
    .select({ id: chatChannelMembers.id })
    .from(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    )
    .limit(1);

  return Boolean(membership);
}

/**
 * A record chat is readable by whoever may see the record: the workspace
 * permission for its type plus the provider's record check (ownership scope,
 * project membership, not deleted, …). Following it (a membership row) grants
 * nothing, so a follower who lost access to the record loses the chat too. A
 * chat whose type has no provider is closed to everyone.
 */
async function canReadRecordChat(
  db: Database,
  channel: { entityType: string | null; entityId: string | null },
  userId: string,
  can: PermissionCheck | undefined,
): Promise<boolean> {
  if (!channel.entityType || !channel.entityId) return false;
  const provider = getEntityProvider(channel.entityType);
  if (!provider) return false;
  return canAccessEntity(provider, {
    db,
    actingUserId: userId,
    entityId: channel.entityId,
    can: can ?? userPermissionCheck(db, userId),
  });
}

/**
 * Of `channelIds`, the record chats `userId` may NOT read; every other channel
 * is left out of the answer. For the listings that start from the user's
 * memberships (search, the channel list, directories): a record chat they
 * follow but whose record they can no longer see has to drop out of those too.
 */
export async function unreadableRecordChatIds(
  db: Database,
  userId: string,
  channelIds: string[],
  options: ChannelAccessOptions = {},
): Promise<Set<string>> {
  const unreadable = new Set<string>();
  if (channelIds.length === 0) return unreadable;

  const rows = await db
    .select({ id: chatChannels.id, entityType: chatChannels.entityType, entityId: chatChannels.entityId })
    .from(chatChannels)
    .where(and(inArray(chatChannels.id, channelIds), eq(chatChannels.type, 'entity')));

  const can = options.can ?? userPermissionCheck(db, userId);
  const byType = new Map<string, typeof rows>();
  for (const row of rows) byType.set(row.entityType ?? '', [...(byType.get(row.entityType ?? '') ?? []), row]);

  for (const [entityType, typeRows] of byType) {
    const entityIds = typeRows.flatMap((r) => (r.entityId ? [r.entityId] : []));
    const visible = await visibleEntityIds(db, userId, can, entityType, entityIds);
    for (const row of typeRows) if (!row.entityId || !visible.has(row.entityId)) unreadable.add(row.id);
  }
  return unreadable;
}

/** The records of one type, out of `entityIds`, that `userId` may see. None for a type without a provider. */
async function visibleEntityIds(
  db: Database,
  userId: string,
  can: PermissionCheck,
  entityType: string,
  entityIds: string[],
): Promise<Set<string>> {
  const provider = getEntityProvider(entityType);
  if (!provider || !(await can(provider.requiredPermission))) return new Set();
  return provider.filterVisible({ db, actingUserId: userId, can }, [...new Set(entityIds)]);
}

/**
 * Resolve a message's channel and answer whether the caller may read it.
 * Returns `false` for unknown / soft-deleted messages so callers can answer
 * with a 404/403 without leaking existence of private-channel content.
 */
export async function canAccessMessage(
  db: Database,
  messageId: string,
  userId: string,
  options: ChannelAccessOptions = {},
): Promise<boolean> {
  const [msg] = await db
    .select({ channelId: chatMessages.channelId })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
    .limit(1);

  if (!msg?.channelId) return false;
  return canAccessChannel(db, msg.channelId, userId, options);
}

/**
 * The caller's role in a channel (`owner` | `admin` | `member`), or `null` when
 * they have no membership row. Use to gate moderation actions.
 */
export async function getChannelRole(
  db: Database,
  channelId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: chatChannelMembers.role })
    .from(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    )
    .limit(1);
  return row?.role ?? null;
}

/**
 * True when the caller is an OWNER or ADMIN of the workspace itself.
 *
 * Only the built-in `workspace_members.role` string is consulted — a member on
 * a custom role (`roleId`) is not treated as an admin here, even if that role
 * carries `weldchat:*`. Matches `isAdminOrOwner()` in services/mail/access.ts.
 */
async function isWorkspaceAdmin(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  const role = row?.role?.toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * True when the caller may moderate the channel — i.e. they are an `admin` or
 * `owner` member of the channel, OR an admin/owner of the workspace.
 *
 * The workspace-level fallback exists because channel membership roles are
 * assigned per channel: a workspace admin who never joined a channel (or who
 * joined as a plain `member`) previously could not delete, rename, or moderate
 * it at all, which contradicts what `weldchat:*` grants them. Every caller
 * runs canAccessChannel() first, so this does NOT reach into private channels
 * or DMs the admin is not a member of — the membership boundary is unchanged
 * and admins still cannot read or moderate other people's DMs.
 */
export async function isChannelModerator(
  db: Database,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const role = await getChannelRole(db, channelId, userId);
  if (role === 'admin' || role === 'owner') return true;
  return isWorkspaceAdmin(db, userId);
}

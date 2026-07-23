/**
 * WeldChat channel-access service.
 *
 * Pure functions (no Hono context) that enforce the WeldChat read boundary:
 * a user may see a channel (and its messages) when the channel is PUBLIC, or
 * when the caller has a `chatChannelMembers` row for it. Private / DM channels
 * leak nothing to non-members.
 *
 * This mirrors the membership-aware pattern already used by chat-directories,
 * chat-dm, and chat-search. Every query is scoped through the tenant
 * `Database` handed in by the caller.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';

const { chatChannels, chatChannelMembers, chatMessages } = schema;

/**
 * True when the caller may read the given channel — i.e. the channel is a
 * non-deleted public channel, or the caller has a membership row for it.
 *
 * Returns `false` for unknown / soft-deleted channels so callers can answer
 * with a 403 without leaking existence.
 */
export async function canAccessChannel(
  db: Database,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const [channel] = await db
    .select({ id: chatChannels.id, type: chatChannels.type })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt)))
    .limit(1);

  if (!channel) return false;
  if (channel.type === 'public') return true;

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
 * Resolve a message's channel and answer whether the caller may read it.
 * Returns `false` for unknown / soft-deleted messages so callers can answer
 * with a 404/403 without leaking existence of private-channel content.
 */
export async function canAccessMessage(
  db: Database,
  messageId: string,
  userId: string,
): Promise<boolean> {
  const [msg] = await db
    .select({ channelId: chatMessages.channelId })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
    .limit(1);

  if (!msg?.channelId) return false;
  return canAccessChannel(db, msg.channelId, userId);
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

/** True when the caller is an `admin` or `owner` member of the channel. */
export async function isChannelModerator(
  db: Database,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const role = await getChannelRole(db, channelId, userId);
  return role === 'admin' || role === 'owner';
}

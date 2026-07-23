/**
 * WeldChat DM membership + channel mute service.
 *
 * Pure functions (no Hono context) that back the membership mutations on the
 * flat /api/chat-dm/* and /api/channels/* surfaces. Behaviour is ported from
 * the obsolete mobile-api-worker chat routes
 * (apps/mobile-api-worker/src/routes/v1/chat/index.ts):
 *
 *   - Archive / unarchive a DM   → `chatChannels.isArchived` (channel-level;
 *     acceptable for 1:1 DMs, matching the legacy worker).
 *   - Pin / unpin a DM           → `chatChannels.metadata.pinnedBy[]`
 *     (per-user; the membership row has no pin column).
 *   - Delete (leave) a DM        → removes the caller's `chatChannelMembers`
 *     row.
 *   - Mute / unmute a channel    → `chatChannelMembers.isMuted` for the caller.
 *
 * Every query is scoped through the tenant `Database` handed in by the caller.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '../../db';

const { chatChannels, chatChannelMembers } = schema;

/**
 * Confirm the caller is a member of the given DM channel.
 * Returns the membership id, or `null` when the caller is not a member.
 */
async function findMembership(
  db: Database,
  channelId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const [membership] = await db
    .select({ id: chatChannelMembers.id })
    .from(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    )
    .limit(1);
  return membership ?? null;
}

/**
 * Set the archived flag on a DM channel. Requires the caller to be a member.
 * Returns `false` when the caller is not a member (→ 404 at the route).
 */
export async function setDmArchived(
  db: Database,
  channelId: string,
  userId: string,
  isArchived: boolean,
): Promise<boolean> {
  const membership = await findMembership(db, channelId, userId);
  if (!membership) return false;

  await db
    .update(chatChannels)
    .set({ isArchived, updatedAt: new Date() })
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.type, 'dm')));

  return true;
}

/**
 * Pin / unpin a DM for the current user. Pin state is stored per-user in
 * `chatChannels.metadata.pinnedBy[]` (the membership row has no pin column).
 * Returns `false` when the channel does not exist (→ 404 at the route).
 */
export async function setDmPinned(
  db: Database,
  channelId: string,
  userId: string,
  isPinned: boolean,
): Promise<boolean> {
  const [channel] = await db
    .select({ metadata: chatChannels.metadata })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), eq(chatChannels.type, 'dm')))
    .limit(1);

  if (!channel) return false;

  const meta = (channel.metadata as Record<string, unknown> | null) ?? {};
  const pinnedBy = Array.isArray(meta.pinnedBy) ? (meta.pinnedBy as string[]) : [];
  const newPinnedBy = isPinned
    ? Array.from(new Set([...pinnedBy, userId]))
    : pinnedBy.filter((id) => id !== userId);

  await db
    .update(chatChannels)
    .set({ metadata: { ...meta, pinnedBy: newPinnedBy }, updatedAt: new Date() })
    .where(eq(chatChannels.id, channelId));

  return true;
}

/**
 * Delete (leave) a DM for the current user — removes their membership row.
 * Returns `false` when the caller was not a member (→ 404 at the route).
 */
export async function leaveDm(
  db: Database,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const membership = await findMembership(db, channelId, userId);
  if (!membership) return false;

  await db
    .delete(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    );

  return true;
}

/**
 * Mute / unmute a channel for the current user (updates `isMuted` on their
 * membership row). Returns the updated membership, or `null` when the caller
 * is not a member (→ 404 at the route).
 */
export async function setChannelMuted(
  db: Database,
  channelId: string,
  userId: string,
  isMuted: boolean,
): Promise<typeof chatChannelMembers.$inferSelect | null> {
  const [updated] = await db
    .update(chatChannelMembers)
    .set({ isMuted })
    .where(
      and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    )
    .returning();

  return updated ?? null;
}

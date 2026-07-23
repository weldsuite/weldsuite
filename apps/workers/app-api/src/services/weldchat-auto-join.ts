/**
 * WeldChat auto-join helpers.
 *
 * Public channels in weldchat are workspace-wide: every internal member is
 * automatically a member. These helpers materialize that invariant whenever a
 * trigger fires (channel created, workspace member activated).
 *
 * Ported verbatim from api-worker `src/services/weldchat-auto-join.ts`
 * (W3 legacy-worker phase-out).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

export interface PublicChannelInfo {
  id: string;
  name: string;
}

/**
 * Join a single internal user to every public channel in the workspace they
 * are not already a member of. No-op for guests.
 *
 * Returns the channels the user was newly added to (caller can fire realtime
 * notifications).
 */
export async function autoJoinUserToPublicChannels(
  db: Database,
  userId: string,
  memberType: string | null | undefined,
): Promise<PublicChannelInfo[]> {
  if (memberType !== 'INTERNAL') return [];

  const { chatChannels, chatChannelMembers } = schema;

  const publicChannels = await db
    .select({ id: chatChannels.id, name: chatChannels.name })
    .from(chatChannels)
    .where(
      and(
        eq(chatChannels.type, 'public'),
        isNull(chatChannels.deletedAt),
      ),
    );

  if (publicChannels.length === 0) return [];

  const existing = await db
    .select({ channelId: chatChannelMembers.channelId })
    .from(chatChannelMembers)
    .where(eq(chatChannelMembers.userId, userId));
  const existingSet = new Set(existing.map((r) => r.channelId));

  const toInsert = publicChannels.filter((ch) => !existingSet.has(ch.id));
  if (toInsert.length === 0) return [];

  const now = new Date();
  await db
    .insert(chatChannelMembers)
    .values(
      toInsert.map((ch) => ({
        id: generateId('cmb'),
        channelId: ch.id,
        userId,
        role: 'member',
        joinedAt: now,
        createdAt: now,
      })),
    )
    .onConflictDoNothing();

  for (const ch of toInsert) {
    await db
      .update(chatChannels)
      .set({
        memberCount: sql`(SELECT count(*)::int FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${ch.id})`,
        updatedAt: now,
      })
      .where(eq(chatChannels.id, ch.id));
  }

  return toInsert;
}

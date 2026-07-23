/**
 * WeldChat auto-join helpers (workspace-worker copy).
 *
 * Mirrors apps/api-worker/src/services/weldchat-auto-join.ts. When a
 * workspace member transitions to ACTIVE through a Clerk webhook, we join
 * them to every public weldchat channel in the workspace.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { Database } from '../db';
import { generateId } from './id';

export interface PublicChannelInfo {
  id: string;
  name: string;
}

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

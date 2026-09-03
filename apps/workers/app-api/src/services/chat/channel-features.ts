/**
 * Chat channel feature-flag enforcement (threads / attachments / reactions / slow mode).
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';

const { chatChannels, chatMessages } = schema;

export interface ChannelFeatureFlags {
  threadsEnabled: boolean;
  attachmentsEnabled: boolean;
  reactionsEnabled: boolean;
  slowModeSeconds: number;
}

export async function getChannelFeatureFlags(
  db: Database,
  channelId: string,
): Promise<ChannelFeatureFlags | null> {
  const [row] = await db
    .select({
      threadsEnabled: chatChannels.threadsEnabled,
      attachmentsEnabled: chatChannels.attachmentsEnabled,
      reactionsEnabled: chatChannels.reactionsEnabled,
      slowModeSeconds: chatChannels.slowModeSeconds,
    })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt)))
    .limit(1);

  if (!row) return null;
  return {
    threadsEnabled: row.threadsEnabled ?? true,
    attachmentsEnabled: row.attachmentsEnabled ?? true,
    reactionsEnabled: row.reactionsEnabled ?? true,
    slowModeSeconds: row.slowModeSeconds ?? 0,
  };
}

/** Returns an error message when the sender is still inside the slow-mode window. */
export async function checkSlowMode(
  db: Database,
  channelId: string,
  authorUserId: string,
  slowModeSeconds: number,
): Promise<string | null> {
  if (!slowModeSeconds || slowModeSeconds <= 0) return null;
  const cutoff = new Date(Date.now() - slowModeSeconds * 1000);
  const [recent] = await db
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.authorId, authorUserId),
        isNull(chatMessages.deletedAt),
        gt(chatMessages.createdAt, cutoff),
      ),
    )
    .limit(1);

  if (!recent) return null;
  return `Slow mode is enabled — wait ${slowModeSeconds}s between messages`;
}

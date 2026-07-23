/**
 * WeldChat message reactions service (app-api).
 *
 * Reactions are stored on `chatMessages.reactions` as a JSONB map of
 * `emoji -> userId[]`. Toggling adds/removes the calling user from the
 * emoji's user list, pruning empty emoji keys. Pure functions — no Hono
 * context, every query is tenant-scoped via the passed `db`.
 *
 * Ported from apps/api-worker/src/routes/chat/messages.ts.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';

const t = schema.chatMessages;

export interface ReactionResult {
  messageId: string;
  channelId: string;
  reactions: Record<string, string[]>;
}

/**
 * Add `userId` to the `emoji` reaction on a message. Idempotent — adding a
 * reaction the user already gave is a no-op. Returns `null` when the message
 * does not exist (or is soft-deleted).
 */
export async function addReaction(
  db: Database,
  messageId: string,
  emoji: string,
  userId: string,
): Promise<ReactionResult | null> {
  const [message] = await db
    .select({ reactions: t.reactions, channelId: t.channelId })
    .from(t)
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)))
    .limit(1);

  if (!message) return null;

  const reactions: Record<string, string[]> = message.reactions ?? {};
  if (!reactions[emoji]) reactions[emoji] = [];
  if (!reactions[emoji].includes(userId)) reactions[emoji].push(userId);

  await db
    .update(t)
    .set({ reactions, updatedAt: new Date() })
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)));

  return { messageId, channelId: message.channelId, reactions };
}

/**
 * Remove `userId` from the `emoji` reaction on a message, pruning the emoji
 * key when no users remain. Returns `null` when the message does not exist
 * (or is soft-deleted).
 */
export async function removeReaction(
  db: Database,
  messageId: string,
  emoji: string,
  userId: string,
): Promise<ReactionResult | null> {
  const [message] = await db
    .select({ reactions: t.reactions, channelId: t.channelId })
    .from(t)
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)))
    .limit(1);

  if (!message) return null;

  const reactions: Record<string, string[]> = message.reactions ?? {};
  if (reactions[emoji]) {
    reactions[emoji] = reactions[emoji].filter((id) => id !== userId);
    if (reactions[emoji].length === 0) delete reactions[emoji];
  }

  await db
    .update(t)
    .set({ reactions, updatedAt: new Date() })
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)));

  return { messageId, channelId: message.channelId, reactions };
}

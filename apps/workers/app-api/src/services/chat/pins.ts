/**
 * WeldChat message pinning service (app-api).
 *
 * A pinned message carries `isPinned=true` plus `pinnedAt`/`pinnedBy` and an
 * optional `pinExpiresAt`. Pure functions — no Hono context, every query is
 * tenant-scoped via the passed `db`.
 *
 * Ported from apps/api-worker/src/routes/chat/messages.ts. Auto-unpin
 * scheduling lives in the route layer (routes/chat-messages pin endpoints),
 * which dispatches the UNPIN_EXPIRED_MESSAGE workflow now hosted in app-api
 * (src/workflows/unpin-expired-message.ts, names `unpin-expired-message-v2*`).
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';

const t = schema.chatMessages;

export interface PinResult {
  messageId: string;
  channelId: string;
  isPinned: boolean;
  pinnedAt: Date | null;
  pinnedBy: string | null;
  pinExpiresAt: Date | null;
}

/**
 * Pin a message. Returns `null` when the message does not exist (or is
 * soft-deleted). `expiresAt` is an optional ISO string.
 */
export async function pinMessage(
  db: Database,
  messageId: string,
  userId: string,
  expiresAt?: string,
): Promise<PinResult | null> {
  const [existing] = await db
    .select({ id: t.id, channelId: t.channelId })
    .from(t)
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)))
    .limit(1);

  if (!existing) return null;

  const now = new Date();
  const pinExpiresAt = expiresAt ? new Date(expiresAt) : null;

  await db
    .update(t)
    .set({ isPinned: true, pinnedAt: now, pinnedBy: userId, pinExpiresAt, updatedAt: now })
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)));

  return {
    messageId,
    channelId: existing.channelId,
    isPinned: true,
    pinnedAt: now,
    pinnedBy: userId,
    pinExpiresAt,
  };
}

/**
 * Unpin a message. Returns `null` when the message does not exist (or is
 * soft-deleted).
 */
export async function unpinMessage(
  db: Database,
  messageId: string,
): Promise<PinResult | null> {
  const [existing] = await db
    .select({ id: t.id, channelId: t.channelId })
    .from(t)
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)))
    .limit(1);

  if (!existing) return null;

  await db
    .update(t)
    .set({ isPinned: false, pinnedAt: null, pinnedBy: null, pinExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(t.id, messageId), isNull(t.deletedAt)));

  return {
    messageId,
    channelId: existing.channelId,
    isPinned: false,
    pinnedAt: null,
    pinnedBy: null,
    pinExpiresAt: null,
  };
}

/**
 * List pinned messages for a channel, newest pin first.
 */
export async function listPinnedMessages(db: Database, channelId: string) {
  return db
    .select()
    .from(t)
    .where(and(eq(t.channelId, channelId), eq(t.isPinned, true), isNull(t.deletedAt)))
    .orderBy(desc(t.pinnedAt));
}

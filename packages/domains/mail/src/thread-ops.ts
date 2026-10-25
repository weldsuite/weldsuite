/**
 * Thread-level write operations.
 *
 * Read aggregation lives in `./threads.ts` (used by the labels/threads
 * endpoint). This file is the bulk-mutation side — anything that needs
 * to touch every message in a thread in one statement.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailCaller } from './access';
import { threadListScope } from './threads';

const { mailMessages } = schema;

/**
 * Flip `isRead` on every message in a thread in a single UPDATE.
 *
 * Without this, opening a thread with N unread messages would either
 * leave siblings unread (if only the focused message was marked) or
 * cost N round-trips. We gate on `isRead = !next` so the UPDATE only
 * touches rows that actually change — keeps `updated_at` honest.
 * `updatedIds` lists those rows (the "email read" push dismisses them).
 */
export async function markThreadRead(
  db: Database,
  accountId: string,
  threadId: string,
  isRead: boolean,
): Promise<{ updatedCount: number; updatedIds: string[] }> {
  const result = await db
    .update(mailMessages)
    .set({ isRead, updatedAt: new Date() })
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ${threadId}`,
        isNull(mailMessages.deletedAt),
        eq(mailMessages.isRead, !isRead),
      ),
    )
    .returning({ id: mailMessages.id });
  return { updatedCount: result.length, updatedIds: result.map((r) => r.id) };
}

/**
 * "Mark all as read" for a folder: every unread message of every thread the
 * folder lists, in one UPDATE. The folder is one account's, or the unified
 * one over every account the caller can read (no `accountId`); which threads
 * it holds comes from `threadListScope`, the listing's own rules.
 *
 * Whole threads, like `markThreadRead`: a row's unread count covers the
 * replies in other folders too, so marking only the folder's own messages
 * would leave rows bold. `updated` is newest first, for the "email read" push.
 */
export async function markFolderRead(
  db: Database,
  caller: MailCaller,
  input: { labelSlug: string; accountId?: string },
): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }> {
  const scope = await threadListScope(db, caller, input);
  if (!scope) return { updatedCount: 0, updated: [] };

  const threadIdExpr = sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id})`;
  const folderThreads = db
    .select({ accountId: mailMessages.accountId, threadKey: threadIdExpr })
    .from(mailMessages)
    .where(and(...scope.conditions));

  const rows = await db
    .update(mailMessages)
    .set({ isRead: true, updatedAt: new Date() })
    .where(
      and(
        scope.accountScope,
        isNull(mailMessages.deletedAt),
        eq(mailMessages.isRead, false),
        sql`(${mailMessages.accountId}, ${threadIdExpr}) IN ${folderThreads}`,
      ),
    )
    .returning({
      id: mailMessages.id,
      accountId: mailMessages.accountId,
      receivedDate: mailMessages.receivedDate,
      sentDate: mailMessages.sentDate,
    });

  const time = (r: (typeof rows)[number]) => new Date(r.receivedDate ?? r.sentDate ?? 0).getTime();
  rows.sort((a, b) => time(b) - time(a));
  return { updatedCount: rows.length, updated: rows.map((r) => ({ id: r.id, accountId: r.accountId })) };
}

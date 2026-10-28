/**
 * Thread-level write operations.
 *
 * Read aggregation lives in `./threads.ts` (used by the labels/threads
 * endpoint). This file is the bulk-mutation side — anything that needs
 * to touch every message in a thread in one statement.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailCaller } from './access';
import { threadListScope, threadListScopeForAccounts, type ThreadListFilter, type ThreadScope } from './threads';

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
  now: Date = new Date(),
): Promise<{ updatedCount: number; updatedIds: string[] }> {
  const result = await db
    .update(mailMessages)
    .set({ isRead, updatedAt: now })
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

/** Messages one "mark all as read" statement touches. Keeps each UPDATE short and its result small. */
const MARK_READ_BATCH_SIZE = 1000;
/**
 * Statements per call (50 000 messages at the default size). A mailbox with
 * more unread mail than that is finished by pressing the button again, rather
 * than one request running into the Worker's time and subrequest limits.
 */
const MARK_READ_MAX_BATCHES = 50;
/** Updated messages kept per mailbox for the "email read" push. */
const MARK_READ_UPDATED_PER_ACCOUNT = 200;

export interface MarkFolderReadOptions {
  /** Messages per UPDATE (default 1000). */
  batchSize?: number;
  /** Most UPDATEs one call runs (default 50). */
  maxBatches?: number;
  /** Updated messages returned per mailbox, newest first (default 200). The count is always complete. */
  updatedPerAccount?: number;
}

/**
 * "Mark all as read" for a folder: every unread message of every thread the
 * folder lists. The folder is one account's, or the unified one over every
 * account the caller can read (no `accountId`); which threads it holds comes
 * from `threadListScope`, the listing's own rules.
 *
 * Whole threads, like `markThreadRead`: a row's unread count covers the
 * replies in other folders too, so marking only the folder's own messages
 * would leave rows bold.
 *
 * Done in bounded batches, newest mail first: pick up to `batchSize` unread ids,
 * then UPDATE exactly those, until none are left or `maxBatches` ran. A shared
 * mailbox with `labelSlug: 'all'` can hold hundreds of thousands of unread
 * messages, too many for one statement or one Worker's memory. `updatedCount`
 * counts every message marked; `updated` lists only the newest
 * `updatedPerAccount` per mailbox, newest first, for the "email read" push.
 */
export async function markFolderRead(
  db: Database,
  caller: MailCaller,
  input: ThreadListFilter & { labelSlug: string; accountId?: string },
  options: MarkFolderReadOptions = {},
  now: Date = new Date(),
): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }> {
  const scope = await threadListScope(db, caller, input);
  if (!scope) return { updatedCount: 0, updated: [] };
  // `updatedIds` is additive, for `markFolderReadForAccounts`/the op
  // dispatcher (design task B4); this keeps the existing callers' exact
  // return shape, same as before that field existed.
  const { updatedCount, updated } = await markFolderReadWithScope(db, scope, options, now);
  return { updatedCount, updated };
}

/**
 * The accounts-list twin of {@link markFolderRead} (design task B4, op
 * `folder.read`): `accountIds` is the store's already-resolved scope — its
 * own mailbox, or `WorkspaceMailStore`'s accessible-account list — so this
 * never re-runs a principal access check.
 */
export async function markFolderReadForAccounts(
  db: Database,
  accountIds: string[],
  input: ThreadListFilter & { labelSlug: string },
  options: MarkFolderReadOptions = {},
  now: Date = new Date(),
): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[]; updatedIds: string[] }> {
  const scope = await threadListScopeForAccounts(db, accountIds, input);
  if (!scope) return { updatedCount: 0, updated: [], updatedIds: [] };
  return markFolderReadWithScope(db, scope, options, now);
}

/** The batched mark-all-read pipeline, once the thread scope is known — shared by both callers above. */
async function markFolderReadWithScope(
  db: Database,
  scope: ThreadScope,
  options: MarkFolderReadOptions,
  now: Date = new Date(),
): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[]; updatedIds: string[] }> {
  const batchSize = options.batchSize ?? MARK_READ_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MARK_READ_MAX_BATCHES;
  const updatedPerAccount = options.updatedPerAccount ?? MARK_READ_UPDATED_PER_ACCOUNT;

  // Snoozed mail that came due since the last sweep is back in the inbox
  // before the batches below read it. Never worth failing the mark-all over.
  await scope.buildWake(db).catch((err) => {
    console.error('[mail-thread-ops] waking snoozed mail failed:', err);
  });

  const threadIdExpr = sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id})`;
  const folderThreads = db
    .select({ accountId: mailMessages.accountId, threadKey: threadIdExpr })
    .from(mailMessages)
    .where(and(...scope.conditions));
  const unreadInFolder = and(
    scope.accountScope,
    isNull(mailMessages.deletedAt),
    eq(mailMessages.isRead, false),
    sql`(${mailMessages.accountId}, ${threadIdExpr}) IN ${folderThreads}`,
  );

  let updatedCount = 0;
  const updated: { id: string; accountId: string }[] = [];
  // Every id touched, uncapped — the op dispatcher's `OpResult.updatedIds`
  // (design task B4: "folder.read, thread.read: every id, for the
  // secondary"), as opposed to `updated`, which stays capped for the push.
  const updatedIds: string[] = [];
  const keptPerAccount = new Map<string, number>();

  for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
    // Marked rows leave `unreadInFolder`, so each pass sees the next batch.
    const batch = await db
      .select({ id: mailMessages.id, accountId: mailMessages.accountId })
      .from(mailMessages)
      .where(unreadInFolder)
      .orderBy(sql`COALESCE(${mailMessages.receivedDate}, ${mailMessages.sentDate}) DESC NULLS LAST`)
      .limit(batchSize);
    if (batch.length === 0) break;

    // `isRead = false` again: a message read in the meantime is not counted twice.
    const done = await db
      .update(mailMessages)
      .set({ isRead: true, updatedAt: now })
      .where(
        and(
          inArray(mailMessages.id, batch.map((m) => m.id)),
          eq(mailMessages.isRead, false),
        ),
      )
      .returning({ id: mailMessages.id });
    updatedCount += done.length;

    const doneIds = new Set(done.map((r) => r.id));
    for (const { id, accountId } of batch) {
      if (!doneIds.has(id)) continue;
      updatedIds.push(id);
      const kept = keptPerAccount.get(accountId) ?? 0;
      if (kept >= updatedPerAccount) continue;
      keptPerAccount.set(accountId, kept + 1);
      updated.push({ id, accountId });
    }

    if (batch.length < batchSize) break;
  }

  return { updatedCount, updated, updatedIds };
}

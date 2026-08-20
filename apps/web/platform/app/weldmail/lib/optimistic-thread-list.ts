import type { ThreadSummary } from './thread-utils';
import { threadContainsMessage } from './next-thread';

export type ThreadRef = { messageId: string; threadId?: string | null };

/** threadId → list query identity that originally contained the row */
export type HiddenThreadMap = Map<string, string>;

/**
 * Inbox (and only inbox) drops a conversation on archive. Other folders
 * such as Starred / All Mail keep the row, so they must not be hidden
 * client-side or a later refetch would never restore them.
 */
export function folderHidesOnArchive(folder: string): boolean {
  return folder.toLowerCase() === 'inbox';
}

/** Stable identity for the paginated threads query currently on screen. */
export function mailThreadListKey(parts: {
  accountId: string;
  folder: string;
  page: number;
  pageSize: number;
}): string {
  return `${parts.accountId}:${parts.folder}:${parts.page}:${parts.pageSize}`;
}

export function findThreadIdToHide(
  threads: ThreadSummary[],
  current: ThreadRef,
): string | null {
  if (current.threadId) return current.threadId;
  return (
    threads.find((t) => threadContainsMessage(t, current.messageId, current.threadId))
      ?.threadId ?? null
  );
}

export function filterHiddenThreads(
  threads: ThreadSummary[],
  hiddenIds: { has(id: string): boolean; size?: number },
): ThreadSummary[] {
  if (hiddenIds.size === 0) return threads;
  return threads.filter((t) => !hiddenIds.has(t.threadId));
}

export function countHiddenOnServer(
  serverThreads: ThreadSummary[],
  hiddenIds: { has(id: string): boolean },
): number {
  let n = 0;
  for (const t of serverThreads) {
    if (hiddenIds.has(t.threadId)) n++;
  }
  return n;
}

function sameHiddenMap(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, key] of a) {
    if (b.get(id) !== key) return false;
  }
  return true;
}

/**
 * Drop an overlay entry only when its originating list query is on screen
 * and that snapshot no longer contains the row. A different page/folder
 * must not clear it — the archived thread simply is not in this page.
 */
export function retainHiddenIdsStillOnServer(
  serverThreads: ThreadSummary[],
  hidden: ReadonlyMap<string, string>,
  listKey: string,
): HiddenThreadMap {
  if (hidden.size === 0) return hidden instanceof Map ? hidden : new Map(hidden);
  const next: HiddenThreadMap = new Map();
  for (const [threadId, originKey] of hidden) {
    // Another page/folder, or a loading/empty placeholder for this
    // query, is not a confirmed omission of the originating snapshot.
    if (originKey !== listKey || serverThreads.length === 0) {
      next.set(threadId, originKey);
      continue;
    }
    if (serverThreads.some((t) => t.threadId === threadId)) {
      next.set(threadId, originKey);
    }
  }
  if (hidden instanceof Map && sameHiddenMap(hidden, next)) return hidden;
  return next;
}

export function addHiddenId(
  hidden: ReadonlyMap<string, string>,
  threadId: string,
  listKey: string,
): HiddenThreadMap {
  if (hidden.get(threadId) === listKey) {
    return hidden instanceof Map ? hidden : new Map(hidden);
  }
  const next = new Map(hidden);
  next.set(threadId, listKey);
  return next;
}

export function removeHiddenId(
  hidden: ReadonlyMap<string, string>,
  threadId: string,
): HiddenThreadMap {
  if (!hidden.has(threadId)) {
    return hidden instanceof Map ? hidden : new Map(hidden);
  }
  const next = new Map(hidden);
  next.delete(threadId);
  return next;
}

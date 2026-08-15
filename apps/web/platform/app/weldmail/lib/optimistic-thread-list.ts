import type { ThreadSummary } from './thread-utils';
import { threadContainsMessage } from './next-thread';

export type ThreadRef = { messageId: string; threadId?: string | null };

/**
 * Inbox (and only inbox) drops a conversation on archive. Other folders
 * such as Starred / All Mail keep the row, so they must not be hidden
 * client-side or a later refetch would never restore them.
 */
export function folderHidesOnArchive(folder: string): boolean {
  return folder.toLowerCase() === 'inbox';
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
  hiddenIds: ReadonlySet<string>,
): ThreadSummary[] {
  if (hiddenIds.size === 0) return threads;
  return threads.filter((t) => !hiddenIds.has(t.threadId));
}

/**
 * Keep an id hidden only while the server snapshot still contains it.
 * Once the refetch drops the row, the overlay entry can go away.
 * Stale refetches that still include the row stay filtered.
 */
export function retainHiddenIdsStillOnServer(
  serverThreads: ThreadSummary[],
  hiddenIds: ReadonlySet<string>,
): Set<string> {
  if (hiddenIds.size === 0) return hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds);
  const next = new Set<string>();
  for (const id of hiddenIds) {
    if (serverThreads.some((t) => t.threadId === id)) next.add(id);
  }
  if (next.size === hiddenIds.size) {
    return hiddenIds instanceof Set ? hiddenIds : next;
  }
  return next;
}

export function addHiddenId(hiddenIds: ReadonlySet<string>, threadId: string): Set<string> {
  if (hiddenIds.has(threadId)) {
    return hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds);
  }
  const next = new Set(hiddenIds);
  next.add(threadId);
  return next;
}

export function removeHiddenId(hiddenIds: ReadonlySet<string>, threadId: string): Set<string> {
  if (!hiddenIds.has(threadId)) {
    return hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds);
  }
  const next = new Set(hiddenIds);
  next.delete(threadId);
  return next;
}

import type { ThreadSummary } from './thread-utils';

export interface ThreadListLocation {
  isUnified: boolean;
  folder: string;
  accountId: string;
}

function folderPath(folder: string): string {
  return folder.toLowerCase() === 'inbox' ? 'inbox' : folder.toLowerCase();
}

export function threadContainsMessage(
  thread: ThreadSummary,
  messageId: string,
  threadId?: string | null,
): boolean {
  if (threadId && thread.threadId === threadId) return true;
  if (thread.latestMessageId === messageId) return true;
  return thread.messages?.some((m) => m.id === messageId) ?? false;
}

/** URL for a thread in the mailbox currently being viewed (unified or per-account). */
export function hrefForThread(thread: ThreadSummary, loc: ThreadListLocation): string {
  const folder = folderPath(loc.folder);
  if (loc.isUnified) {
    const acctParam = thread.accountId ? `?accountId=${thread.accountId}` : '';
    return `/weldmail/unified/${folder}/${thread.latestMessageId}${acctParam}`;
  }
  return `/weldmail/${loc.accountId}/${folder}/${thread.latestMessageId}`;
}

/**
 * Href of the conversation *below* the current one in the visible list.
 * Captured before archive so the current row is still in the array.
 * Returns null when the current thread is last (or not in the list).
 */
export function getNextThreadHref(
  threads: ThreadSummary[],
  current: { messageId: string; threadId?: string | null },
  loc: ThreadListLocation,
): string | null {
  const index = threads.findIndex((t) =>
    threadContainsMessage(t, current.messageId, current.threadId),
  );
  if (index < 0) return null;
  const next = threads[index + 1];
  if (!next) return null;
  return hrefForThread(next, loc);
}

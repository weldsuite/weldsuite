/**
 * Helpers for the infinitely scrolling inbox list.
 *
 * The list is always a contiguous, newest-first prefix of the mailbox that
 * ends where `cursor` points. Refreshes re-read only the first page, so they
 * have to stitch that page back onto the rows the user already scrolled to.
 */

import type { InboxCursor } from '@/services/mail-tenant';
import type { EmailListItem } from '@/types/mail';

type Row = Pick<EmailListItem, 'id' | 'sentDate' | 'receivedDate' | 'createdAt'>;

function rowTime(m: Row): number {
  return Date.parse(m.sentDate || m.receivedDate || m.createdAt || '') || 0;
}

/** True when `a` sorts after `b` in the server's newest-first order. */
export function isOlderThan(a: Row, b: Row): boolean {
  const ta = rowTime(a);
  const tb = rowTime(b);
  return ta < tb || (ta === tb && a.id < b.id);
}

/**
 * Fold a freshly fetched first page onto the list on screen.
 *
 * `prevCursor === undefined` means the list on screen came from the offline
 * cache and its paging position is unknown, so the first page replaces it.
 * Otherwise every loaded row older than the new first page is kept, together
 * with the cursor that already points past it, so a background re-sync (focus,
 * app resume, realtime nudge) never throws away pages the user scrolled into.
 */
export function mergeRefreshedFirstPage<T extends Row>(
  prev: T[],
  firstPage: T[],
  firstPageCursor: InboxCursor | null,
  prevCursor: InboxCursor | null | undefined,
): { list: T[]; cursor: InboxCursor | null } {
  if (prevCursor === undefined || firstPageCursor === null || firstPage.length === 0) {
    return { list: firstPage, cursor: firstPageCursor };
  }
  const boundary = firstPage[firstPage.length - 1]!;
  const ids = new Set(firstPage.map((m) => m.id));
  const tail = prev.filter((m) => !ids.has(m.id) && isOlderThan(m, boundary));
  if (tail.length === 0) return { list: firstPage, cursor: firstPageCursor };
  return { list: [...firstPage, ...tail], cursor: prevCursor };
}

/** Append a page, skipping rows already listed (a row can shift between pages). */
export function appendPage<T extends { id: string }>(prev: T[], page: T[]): T[] {
  const seen = new Set(prev.map((m) => m.id));
  const fresh = page.filter((m) => !seen.has(m.id));
  return fresh.length ? [...prev, ...fresh] : prev;
}

/** Number of loaded messages per thread, for the thread-count badge. */
export function withThreadCounts<T extends { threadId?: string | null; threadCount?: number }>(
  list: T[],
): T[] {
  const counts: Record<string, number> = {};
  for (const m of list) {
    if (m.threadId) counts[m.threadId] = (counts[m.threadId] || 0) + 1;
  }
  return list.map((m) => ({ ...m, threadCount: m.threadId ? counts[m.threadId] || 1 : 1 }));
}

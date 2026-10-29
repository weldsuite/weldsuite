/**
 * k-way merge of per-mailbox pages for unified listings and search (design
 * §5). Each mailbox already returned its own top page in the shared sort
 * order; this combines them into one page without re-querying, and reports
 * whether the merged page might be missing rows a mailbox still holds.
 *
 * No I/O: safe in the object, in a worker, and in a test.
 */

export interface MergeSource<T> {
  /** This mailbox's page, already sorted in the merge order. */
  items: readonly T[];
  /** True when this mailbox has more rows past `items` (its own page was full). */
  hasMore: boolean;
}

export interface MergeResult<T> {
  items: T[];
  /**
   * True when the merged page may not be the true top `limit`: either more
   * rows were available across every mailbox than `limit`, or any single
   * mailbox reported it had more of its own. The second half is
   * conservative — design §5: "`nextCursor` is the last item if any mailbox
   * had more" — so a caller never silently skips a row by assuming the list
   * ended.
   */
  hasMore: boolean;
}

/**
 * Merge already-sorted pages into one page of at most `limit` items in
 * `compare` order. Stable: items that compare equal keep their relative
 * source order (the mailbox order the caller passed in, then within-page
 * order), so paging is deterministic across identical inputs.
 */
export function mergeSortedPages<T>(
  sources: readonly MergeSource<T>[],
  compare: (a: T, b: T) => number,
  limit: number,
): MergeResult<T> {
  const tagged: Array<{ item: T; source: number; index: number }> = [];
  sources.forEach((source, sourceIndex) => {
    source.items.forEach((item, index) => tagged.push({ item, source: sourceIndex, index }));
  });
  tagged.sort((a, b) => {
    const cmp = compare(a.item, b.item);
    if (cmp !== 0) return cmp;
    if (a.source !== b.source) return a.source - b.source;
    return a.index - b.index;
  });

  const anySourceHasMore = sources.some((s) => s.hasMore);
  const items = tagged.slice(0, Math.max(0, limit)).map((t) => t.item);
  const hasMore = anySourceHasMore || tagged.length > limit;
  return { items, hasMore };
}

// ---------------------------------------------------------------------------
// Ready-made comparators for the two shared sort orders (design §5)
// ---------------------------------------------------------------------------

export interface ThreadOrderKey {
  latestAt: number;
  accountId: string;
  threadKey: string;
}

/** `(latestAt DESC, accountId ASC, threadKey ASC)` — the unified thread list's total order. */
export function compareThreadOrder(a: ThreadOrderKey, b: ThreadOrderKey): number {
  if (a.latestAt !== b.latestAt) return b.latestAt - a.latestAt;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  if (a.threadKey !== b.threadKey) return a.threadKey < b.threadKey ? -1 : 1;
  return 0;
}

export interface MessageOrderKey {
  sentAt: number;
  id: string;
}

/** `(sentAt DESC, id DESC)` — the unified message list's total order. */
export function compareMessageOrder(a: MessageOrderKey, b: MessageOrderKey): number {
  if (a.sentAt !== b.sentAt) return b.sentAt - a.sentAt;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/**
 * Wrap an order-key comparator to work on any `T` via a projection — so a
 * caller merging `ThreadSummary[]` or `MailMessageListRow[]` doesn't need to
 * reshape its rows just to sort them.
 */
export function byOrderKey<T, K>(compare: (a: K, b: K) => number, project: (item: T) => K): (a: T, b: T) => number {
  return (a, b) => compare(project(a), project(b));
}

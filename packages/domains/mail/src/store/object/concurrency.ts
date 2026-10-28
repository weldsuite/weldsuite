/**
 * Bounded-concurrency fan-out, used throughout `store/object/` for the two
 * natural parallel-call sites the design calls for: `ObjectWorkspaceMailStore`
 * asking several mailboxes the same question at once (design §5, "parallel
 * `mailbox(a).listThreads(...)`"), and `ObjectMailboxStore` reading several
 * messages' R2 bodies at once (`getThread`/`listScheduled`/`exportPage`).
 *
 * No I/O of its own: safe in a worker or a test.
 */

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * returning results in the same order as `items` regardless of completion
 * order. A plain `Promise.all(items.map(fn))` would start every call at once;
 * this caps it, since one page of a unified inbox read can span dozens of
 * mailboxes and one `getThread` can span up to 1000 messages (design §3.3's
 * thread cap), and Workers subrequests aren't free.
 *
 * `limit` is clamped to `[1, items.length]` so a caller passing `0` or a
 * limit larger than the input never changes behaviour beyond "no concurrency
 * cap in effect".
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const bound = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

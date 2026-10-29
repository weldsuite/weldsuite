/**
 * Shared TanStack Query v5 `infiniteQueryOptions()` factory for a label's
 * thread list — the one cache entry read by `useInfiniteMailLabelThreads`
 * (hooks/queries/use-mail-queries.ts), warmed ahead of time by the label
 * route's `beforeLoad` (label-route-prefetch.ts) and by the sidebar hover
 * prefetch (hooks/use-app-prefetch.ts).
 *
 * All three used to hand-roll their own `queryKey` / `queryFn` /
 * `initialPageParam`, and only the hook defined `getNextPageParam`. With the
 * global `staleTime` at 0, every `prefetchInfiniteQuery` call — including the
 * route prefetch firing again when a message route (`$messageId`) resolves
 * under the same label route — refetches every already-loaded page using
 * *its own* options. Past page 1, that walks the cursor chain via
 * `getNextPageParam`, which the two prefetchers never defined, throwing
 * `options.getNextPageParam is not a function` once the list has scrolled
 * past the first page and the TanStack list topples into an error state.
 *
 * Centralizing the options here means the three call sites can never drift:
 * the only thing left to each caller is `fetchPage`, the actual network call,
 * because the hook (Clerk-authed `useAppApi()`), the route prefetch (the
 * module-level browser singleton used in router `beforeLoad`, outside React)
 * and the hover prefetch (`useAppApiClient()`) each reach app-api differently.
 *
 * docs/plans/weldmail-mailbox-storage.md, phase 1 item 7.
 */

import { infiniteQueryOptions } from '@tanstack/react-query';
import type { DataResponse } from '@weldsuite/app-api-client';
import type { MailThreadSummary } from '@weldsuite/app-api-client/domains/mail-labels';
import { mailKeys } from '@/hooks/queries/mail-keys';
// Type-only: erased at compile time, so this doesn't form a runtime import
// cycle with use-mail-queries.ts (which imports this module's
// `mailLabelThreadsInfiniteQueryOptions`). Re-using the canonical type here
// instead of redeclaring it keeps the two from drifting apart.
import type { MailThreadSearch } from '@/hooks/queries/use-mail-queries';

/** Matches the server's default page size for a label's thread list. */
export const MAIL_LABEL_THREADS_PAGE_SIZE = 25;

export interface MailLabelThreadsParams extends MailThreadSearch {
  /** Omitted for the unified inbox. */
  accountId?: string;
  labelSlug: string;
  pageSize?: number;
}

/** Legacy page number, or the mailbox store's keyset cursor. */
type ThreadsPageParam = number | { cursor: string };

/** Also used by the non-hook prefetchers to type their own `appApi.get()` call. */
export type MailLabelThreadsResponse = DataResponse<{
  threads: MailThreadSummary[];
  totalCount: number;
  nextCursor?: string | null;
}>;

/**
 * One request for a page of a label's threads. Matches
 * `mailLabels.threads()`'s params shape (`ListMailLabelThreadsQuery`) exactly,
 * so the hook can pass that typed domain method straight through — the
 * non-hook prefetchers build the equivalent request over their own client.
 */
export type FetchMailLabelThreadsPage = (params: {
  accountId?: string;
  labelSlug: string;
  pageSize: number;
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  excludeWords?: string;
  hasAttachment?: boolean;
  page: number;
  cursor?: string;
}) => Promise<MailLabelThreadsResponse>;

/**
 * Builds the infinite-query options for a label's thread list. `fetchPage` is
 * the only thing that varies between callers; `queryKey`, `initialPageParam`
 * and `getNextPageParam` are identical everywhere so a prefetch always primes
 * exactly the cache entry the hook reads, and a refetch of a multi-page cache
 * entry (TanStack Query v5 refetches every loaded page on a stale
 * `prefetchInfiniteQuery`/mount) can always walk the cursor chain.
 */
export function mailLabelThreadsInfiniteQueryOptions(
  fetchPage: FetchMailLabelThreadsPage,
  params: MailLabelThreadsParams,
) {
  const pageSize = params.pageSize ?? MAIL_LABEL_THREADS_PAGE_SIZE;
  // Omit page/cursor from the key so every scroll page shares one infinite
  // cache entry, and so every caller (hook + both prefetchers) builds the
  // exact same key.
  const queryParams = {
    accountId: params.accountId,
    labelSlug: params.labelSlug,
    pageSize,
    search: params.search || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    subject: params.subject || undefined,
    excludeWords: params.excludeWords || undefined,
    hasAttachment: params.hasAttachment || undefined,
  };

  return infiniteQueryOptions({
    queryKey: mailKeys.threadsByLabel(queryParams),
    queryFn: ({ pageParam }: { pageParam: ThreadsPageParam }) =>
      fetchPage({
        ...queryParams,
        // `page` is required by the schema (it has a server-side default),
        // but the route ignores it whenever `cursor` is present — so a
        // cursor-mode request keeps sending `page: 1` as a harmless filler.
        page: typeof pageParam === 'number' ? pageParam : 1,
        ...(typeof pageParam === 'number' ? {} : { cursor: pageParam.cursor }),
      }),
    initialPageParam: 1 as ThreadsPageParam,
    getNextPageParam: (lastPage, allPages) => {
      const nextCursor = lastPage.data?.nextCursor;
      if (nextCursor !== undefined) {
        // Store-backed cursor: `null` means there are no more threads.
        return nextCursor ? { cursor: nextCursor } : undefined;
      }
      // Legacy response shape without `nextCursor` — page by offset count.
      const totalCount = lastPage.data?.totalCount ?? 0;
      const loaded = allPages.reduce((n, page) => n + (page.data?.threads?.length ?? 0), 0);
      return loaded < totalCount ? allPages.length + 1 : undefined;
    },
  });
}

/**
 * Starts a label route's thread list, labels and stats requests as soon as
 * routing resolves the match — in the route's `beforeLoad`
 * (`src/routes/weldmail/$accountId/$labelSlug/route.tsx`,
 * `src/routes/weldmail/unified/$labelSlug/route.tsx`) — instead of waiting for
 * `useAppAccess('weldmail')` to pass in the layout underneath before the
 * hooks that actually render the page (`useInfiniteMailLabelThreads`,
 * `useMailLabels`, `useMailMessageStats`) get a chance to run.
 *
 * Not awaited by its callers: this fires the requests and returns, so routing
 * proceeds immediately. The hooks mount with the exact same query keys, so
 * TanStack Query hands them the already in-flight promise (or its cached
 * result) instead of issuing a second request.
 *
 * `beforeLoad` re-runs on every navigation under the label route — including
 * opening a message (`$messageId`) and link preloads — not just the first
 * time a label is visited. With the global `staleTime` at 0, calling
 * `prefetchInfiniteQuery`/`prefetchQuery` unconditionally on every one of
 * those would refetch an already-loaded list (and the labels/stats) on every
 * click. For the thread list that's worse than wasteful: TanStack Query v5
 * refetches every already-loaded page of a stale infinite query using the
 * options passed to `prefetchInfiniteQuery`, so a scrolled-past-page-1 list
 * would be refetched using whatever that call's `getNextPageParam` says — see
 * `mail-label-threads-query.ts` for why that must be the hook's own. Each
 * prefetch here is skipped once its query key already has cached data, so a
 * click deeper in the route only warms what isn't warm yet.
 *
 * docs/plans/weldmail-mailbox-storage.md, phase 1 item 7.
 */

import type { QueryClient } from '@tanstack/react-query';
import { buildQueryString, type DataResponse } from '@weldsuite/app-api-client';
import type { MailLabelRow } from '@weldsuite/app-api-client/domains/mail-labels';
import { mailKeys } from '@/hooks/queries/mail-keys';
import type { MailMessageStats } from '@weldsuite/app-api-client/domains/mail-messages';
import { appApi } from '@/lib/api/app-api-browser-client';
import {
  mailLabelThreadsInfiniteQueryOptions,
  MAIL_LABEL_THREADS_PAGE_SIZE,
  type FetchMailLabelThreadsPage,
  type MailLabelThreadsResponse,
} from '@/app/weldmail/lib/mail-label-threads-query';

interface LabelRouteParams {
  /** Omitted for the unified inbox — labels and stats aren't fetched there. */
  accountId?: string;
  labelSlug: string;
}

/** The route prefetch's own transport: the module-level browser singleton (outside React, used from router `beforeLoad`). */
const fetchThreadsPage: FetchMailLabelThreadsPage = (params) =>
  appApi.get<MailLabelThreadsResponse>(`/mail-labels/threads${buildQueryString(params as Record<string, unknown>)}`);

export function prefetchMailLabelRoute(queryClient: QueryClient, { accountId, labelSlug }: LabelRouteParams): void {
  const threadsOptions = mailLabelThreadsInfiniteQueryOptions(fetchThreadsPage, {
    accountId,
    labelSlug,
    pageSize: MAIL_LABEL_THREADS_PAGE_SIZE,
  });
  // Already cached (even as a multi-page list) — skip the refetch entirely.
  // `useInfiniteMailLabelThreads` mounting underneath still reads it fresh.
  if (queryClient.getQueryData(threadsOptions.queryKey) === undefined) {
    void queryClient.prefetchInfiniteQuery(threadsOptions);
  }

  // The per-account page's label chips/colors and folder-count stats — the
  // unified inbox has no single mailbox to ask either of (message-list.tsx,
  // mail-split-layout.tsx both disable these queries without an accountId).
  if (!accountId) return;

  const labelsKey = mailKeys.labels(accountId);
  if (queryClient.getQueryData(labelsKey) === undefined) {
    void queryClient.prefetchQuery({
      queryKey: labelsKey,
      queryFn: () => appApi.get<DataResponse<MailLabelRow[]>>(`/mail-labels${buildQueryString({ accountId })}`),
    });
  }

  const statsKey = mailKeys.messageStats(accountId);
  if (queryClient.getQueryData(statsKey) === undefined) {
    void queryClient.prefetchQuery({
      queryKey: statsKey,
      queryFn: () =>
        appApi.get<DataResponse<MailMessageStats>>(`/mail-messages/stats${buildQueryString({ accountId })}`),
    });
  }
}

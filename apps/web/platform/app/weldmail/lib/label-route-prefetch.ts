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
 * docs/plans/weldmail-mailbox-storage.md, phase 1 item 7.
 */

import type { QueryClient } from '@tanstack/react-query';
import { buildQueryString, type DataResponse } from '@weldsuite/app-api-client';
import type { MailLabelRow, MailThreadSummary } from '@weldsuite/app-api-client/domains/mail-labels';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import type { MailMessageStats } from '@weldsuite/app-api-client/domains/mail-messages';
import { appApi } from '@/lib/api/app-api-browser-client';

/** Matches `useInfiniteMailLabelThreads`'s default page size. */
const PAGE_SIZE = 25;

interface LabelRouteParams {
  /** Omitted for the unified inbox — labels and stats aren't fetched there. */
  accountId?: string;
  labelSlug: string;
}

export function prefetchMailLabelRoute(queryClient: QueryClient, { accountId, labelSlug }: LabelRouteParams): void {
  const threadsParams = { accountId, labelSlug, pageSize: PAGE_SIZE };

  void queryClient.prefetchInfiniteQuery({
    queryKey: mailKeys.threadsByLabel(threadsParams),
    queryFn: ({ pageParam }) =>
      appApi.get<DataResponse<{ threads: MailThreadSummary[]; totalCount: number }>>(
        `/mail-labels/threads${buildQueryString({ ...threadsParams, page: pageParam })}`,
      ),
    initialPageParam: 1,
  });

  // The per-account page's label chips/colors and folder-count stats — the
  // unified inbox has no single mailbox to ask either of (message-list.tsx,
  // mail-split-layout.tsx both disable these queries without an accountId).
  if (!accountId) return;

  void queryClient.prefetchQuery({
    queryKey: mailKeys.labels(accountId),
    queryFn: () => appApi.get<DataResponse<MailLabelRow[]>>(`/mail-labels${buildQueryString({ accountId })}`),
  });

  void queryClient.prefetchQuery({
    queryKey: mailKeys.messageStats(accountId),
    queryFn: () =>
      appApi.get<DataResponse<MailMessageStats>>(`/mail-messages/stats${buildQueryString({ accountId })}`),
  });
}

/**
 * Mailbox-wide search. Hits `GET /api/mail-messages?search=` without an account,
 * so the server searches every account the caller can read, and pages by cursor.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import {
  buildMailSearchParams,
  normalizeSearchQuery,
  type MailSearchFilters,
} from '@/app/weldmail/search/mail-search-utils';

export function useMailSearch(query: string, filters: MailSearchFilters) {
  const { mailMessages } = useAppApi();
  const term = normalizeSearchQuery(query);

  return useInfiniteQuery({
    queryKey: [...mailKeys.search(term), filters] as const,
    queryFn: ({ pageParam }) =>
      mailMessages.list(buildMailSearchParams({ query: term, filters, cursor: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? (lastPage.pagination.cursor ?? undefined) : undefined,
    enabled: term.length > 0,
  });
}

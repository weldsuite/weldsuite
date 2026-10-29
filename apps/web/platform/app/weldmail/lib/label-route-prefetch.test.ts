import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import { prefetchMailLabelRoute } from './label-route-prefetch';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/app-api-browser-client', () => ({ appApi: { get: getMock } }));

describe('prefetchMailLabelRoute', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    getMock.mockReset();
    getMock.mockResolvedValue({ data: [] });
  });

  it('prefetches threads, labels and stats under the same keys the hooks use', () => {
    const prefetchInfiniteQuery = vi.spyOn(queryClient, 'prefetchInfiniteQuery').mockResolvedValue(undefined);
    const prefetchQuery = vi.spyOn(queryClient, 'prefetchQuery').mockResolvedValue(undefined);

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });

    // Matches useInfiniteMailLabelThreads({ accountId, labelSlug, pageSize: 25 }).
    expect(prefetchInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: mailKeys.threadsByLabel({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25 }),
        initialPageParam: 1,
      }),
    );
    // Matches useMailLabels(accountId) and useMailMessageStats(accountId).
    expect(prefetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: mailKeys.labels('macc_1') }),
    );
    expect(prefetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: mailKeys.messageStats('macc_1') }),
    );
  });

  it('skips labels and stats for the unified inbox, which has no single accountId', () => {
    const prefetchInfiniteQuery = vi.spyOn(queryClient, 'prefetchInfiniteQuery').mockResolvedValue(undefined);
    const prefetchQuery = vi.spyOn(queryClient, 'prefetchQuery').mockResolvedValue(undefined);

    prefetchMailLabelRoute(queryClient, { labelSlug: 'inbox' });

    expect(prefetchInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: mailKeys.threadsByLabel({ labelSlug: 'inbox', pageSize: 25 }) }),
    );
    expect(prefetchQuery).not.toHaveBeenCalled();
  });

  it('fetches the thread list from the same path the hook calls', async () => {
    const prefetchInfiniteQuery = vi
      .spyOn(queryClient, 'prefetchInfiniteQuery')
      .mockImplementation(async (opts) => {
        await (opts as unknown as { queryFn: (ctx: { pageParam: number }) => Promise<unknown> }).queryFn({
          pageParam: 1,
        });
      });

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });
    await Promise.resolve();

    expect(prefetchInfiniteQuery).toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith('/mail-labels/threads?accountId=macc_1&labelSlug=inbox&pageSize=25&page=1');
  });

  it('fetches labels and stats from the same paths the hooks call', async () => {
    vi.spyOn(queryClient, 'prefetchQuery').mockImplementation(async (opts) => {
      await (opts as unknown as { queryFn: () => Promise<unknown> }).queryFn();
    });
    vi.spyOn(queryClient, 'prefetchInfiniteQuery').mockResolvedValue(undefined);

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });
    await Promise.resolve();

    expect(getMock).toHaveBeenCalledWith('/mail-labels?accountId=macc_1');
    expect(getMock).toHaveBeenCalledWith('/mail-messages/stats?accountId=macc_1');
  });

  it('builds thread-list options with a getNextPageParam, so a cold-cache prefetch leaves something the hook can paginate from', () => {
    const prefetchInfiniteQuery = vi
      .spyOn(queryClient, 'prefetchInfiniteQuery')
      .mockResolvedValue(undefined);

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });

    const options = prefetchInfiniteQuery.mock.calls[0]?.[0] as { getNextPageParam?: unknown };
    expect(typeof options.getNextPageParam).toBe('function');
  });

  // Regression: `beforeLoad` re-runs on every navigation under the label
  // route, including opening a message (`$messageId`). With global
  // `staleTime: 0`, calling `prefetchInfiniteQuery` unconditionally refetches
  // every already-loaded page of a scrolled-past-page-1 list using these
  // options — and used to throw `getNextPageParam is not a function` doing
  // it. Skipping once the key is already cached avoids both the crash risk
  // and the wasted/visible refetch.
  it('does not refetch an already-cached multi-page thread list', () => {
    const key = mailKeys.threadsByLabel({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25 });
    queryClient.setQueryData(key, {
      pages: [
        { data: { threads: [{ threadId: 't1' }], totalCount: 30, nextCursor: 'cursor-1' } },
        { data: { threads: [{ threadId: 't2' }], totalCount: 30, nextCursor: null } },
      ],
      pageParams: [1, { cursor: 'cursor-1' }],
    });
    const prefetchInfiniteQuery = vi.spyOn(queryClient, 'prefetchInfiniteQuery');

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });

    expect(prefetchInfiniteQuery).not.toHaveBeenCalled();
  });

  it('still prefetches a thread list that is not cached yet', () => {
    const prefetchInfiniteQuery = vi.spyOn(queryClient, 'prefetchInfiniteQuery').mockResolvedValue(undefined);

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });

    expect(prefetchInfiniteQuery).toHaveBeenCalled();
  });

  it('does not refetch labels or stats once they are already cached', () => {
    queryClient.setQueryData(mailKeys.labels('macc_1'), { data: [] });
    queryClient.setQueryData(mailKeys.messageStats('macc_1'), { data: {} });
    vi.spyOn(queryClient, 'prefetchInfiniteQuery').mockResolvedValue(undefined);
    const prefetchQuery = vi.spyOn(queryClient, 'prefetchQuery');

    prefetchMailLabelRoute(queryClient, { accountId: 'macc_1', labelSlug: 'inbox' });

    expect(prefetchQuery).not.toHaveBeenCalled();
  });
});

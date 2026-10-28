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
});

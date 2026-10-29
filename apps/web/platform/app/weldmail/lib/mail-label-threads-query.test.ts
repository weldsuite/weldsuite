/**
 * `mailLabelThreadsInfiniteQueryOptions` is the options factory
 * `useInfiniteMailLabelThreads` (hooks/queries/use-mail-queries.ts), the
 * label route's `beforeLoad` prefetch (label-route-prefetch.ts) and the
 * sidebar hover prefetch (hooks/use-app-prefetch.ts) all build their
 * `useInfiniteQuery`/`prefetchInfiniteQuery` options from. These tests pin
 * down the pieces that must stay identical across every caller — the query
 * key and `getNextPageParam` — independent of whichever `fetchPage`
 * transport a caller supplies.
 */

import { describe, expect, it, vi } from 'vitest';
import { mailKeys } from '@/hooks/queries/mail-keys';
import { MAIL_LABEL_THREADS_PAGE_SIZE, mailLabelThreadsInfiniteQueryOptions } from './mail-label-threads-query';

type QueryFn = (ctx: { pageParam: unknown }) => Promise<unknown>;
type GetNextPageParam = (lastPage: unknown, allPages: unknown[]) => unknown;

describe('mailLabelThreadsInfiniteQueryOptions', () => {
  it('builds the same queryKey the hook and both prefetchers all key off of', () => {
    const options = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });

    expect(options.queryKey).toEqual(
      mailKeys.threadsByLabel({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25 }),
    );
  });

  it('defaults pageSize to 25 and lets an explicit pageSize produce an identical key', () => {
    const defaulted = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });
    const explicit = mailLabelThreadsInfiniteQueryOptions(vi.fn(), {
      accountId: 'macc_1',
      labelSlug: 'inbox',
      pageSize: MAIL_LABEL_THREADS_PAGE_SIZE,
    });

    expect(defaulted.queryKey).toEqual(explicit.queryKey);
  });

  it('always defines getNextPageParam — the bug this factory exists to prevent is a caller without one', () => {
    const options = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });

    expect(typeof options.getNextPageParam).toBe('function');
    expect(typeof options.initialPageParam).toBe('number');
  });

  it('pages by the store cursor once a response carries one', () => {
    const options = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });
    const getNextPageParam = options.getNextPageParam as GetNextPageParam;
    const lastPage = { data: { threads: [{ threadId: 't1' }], totalCount: 2, nextCursor: 'cursor-1' } };

    expect(getNextPageParam(lastPage, [lastPage])).toEqual({ cursor: 'cursor-1' });
  });

  it('stops paging once the store returns nextCursor: null', () => {
    const options = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });
    const getNextPageParam = options.getNextPageParam as GetNextPageParam;
    const lastPage = { data: { threads: [{ threadId: 't1' }], totalCount: 50, nextCursor: null } };

    expect(getNextPageParam(lastPage, [lastPage])).toBeUndefined();
  });

  it('falls back to counting pages when a response has no nextCursor field at all', () => {
    const options = mailLabelThreadsInfiniteQueryOptions(vi.fn(), { accountId: 'macc_1', labelSlug: 'inbox' });
    const getNextPageParam = options.getNextPageParam as GetNextPageParam;
    const page1 = { data: { threads: new Array(25).fill({ threadId: 't' }), totalCount: 30 } };

    expect(getNextPageParam(page1, [page1])).toBe(2);

    const page2 = { data: { threads: new Array(5).fill({ threadId: 't' }), totalCount: 30 } };
    expect(getNextPageParam(page2, [page1, page2])).toBeUndefined();
  });

  it('calls fetchPage with page: 1 and no cursor for the initial page param', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { threads: [], totalCount: 0, nextCursor: null } });
    const options = mailLabelThreadsInfiniteQueryOptions(fetchPage, { accountId: 'macc_1', labelSlug: 'inbox' });
    const queryFn = options.queryFn as unknown as QueryFn;

    await queryFn({ pageParam: options.initialPageParam });

    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25, page: 1 }),
    );
    expect(fetchPage.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
  });

  it('calls fetchPage with the store cursor (and a filler page: 1) once paginating by cursor', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { threads: [], totalCount: 0, nextCursor: null } });
    const options = mailLabelThreadsInfiniteQueryOptions(fetchPage, { accountId: 'macc_1', labelSlug: 'inbox' });
    const queryFn = options.queryFn as unknown as QueryFn;

    await queryFn({ pageParam: { cursor: 'cursor-1' } });

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ page: 1, cursor: 'cursor-1' }));
  });

  it('carries search filters into every request without putting them in a separate key shape', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { threads: [], totalCount: 0, nextCursor: null } });
    const options = mailLabelThreadsInfiniteQueryOptions(fetchPage, {
      accountId: 'macc_1',
      labelSlug: 'inbox',
      from: 'a@b.com',
    });
    const queryFn = options.queryFn as unknown as QueryFn;

    await queryFn({ pageParam: options.initialPageParam });

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ from: 'a@b.com' }));
  });
});

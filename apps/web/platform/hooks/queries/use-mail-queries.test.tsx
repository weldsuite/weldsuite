/**
 * Mailbox-store design E1: cursor paging for the infinite thread list, and
 * the `counterparty` switch for the CRM Emails tab.
 *
 * `useInfiniteMailLabelThreads`'s first request must stay byte-identical to
 * what `label-route-prefetch.ts` fires (same query key, same `page: 1`
 * first page), so a prefetch started from the route's `beforeLoad` is
 * reused instead of double-fetched (see `label-route-prefetch.test.ts`).
 * Only pages after the first should prefer the store's `nextCursor`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  mailKeys,
  useInfiniteMailLabelThreads,
  useMailMessagesByCounterparty,
} from './use-mail-queries';

const threadsMock = vi.fn();
const listMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({
    mailLabels: { threads: (...args: unknown[]) => threadsMock(...args) },
    mailMessages: { list: (...args: unknown[]) => listMock(...args) },
  }),
}));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useInfiniteMailLabelThreads', () => {
  beforeEach(() => {
    threadsMock.mockReset();
    listMock.mockReset();
  });

  it('fetches the first page with the legacy `page`, matching label-route-prefetch.ts exactly', async () => {
    threadsMock.mockResolvedValue({ data: { threads: [{ threadId: 't1' }], totalCount: 1, nextCursor: null } });
    const client = newClient();

    const { result } = renderHook(
      () => useInfiniteMailLabelThreads({ accountId: 'macc_1', labelSlug: 'inbox' }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(threadsMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25, page: 1 }),
    );
    expect(threadsMock.mock.calls[0]?.[0]).not.toHaveProperty('cursor');

    // Same key `label-route-prefetch.ts` builds for `prefetchInfiniteQuery`
    // (label-route-prefetch.test.ts): `{ accountId, labelSlug, pageSize: 25 }`.
    expect(client.getQueryState(mailKeys.threadsByLabel({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25 })))
      .toBeTruthy();
  });

  it('fetches subsequent pages by the store cursor, not by incrementing `page`', async () => {
    threadsMock
      .mockResolvedValueOnce({ data: { threads: [{ threadId: 't1' }], totalCount: 2, nextCursor: 't1:cursor' } })
      .mockResolvedValueOnce({ data: { threads: [{ threadId: 't2' }], totalCount: 2, nextCursor: null } });
    const client = newClient();

    const { result } = renderHook(
      () => useInfiniteMailLabelThreads({ accountId: 'macc_1', labelSlug: 'inbox' }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    expect(threadsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: 'macc_1', labelSlug: 'inbox', pageSize: 25, cursor: 't1:cursor' }),
    );
    // `page` is still sent (the schema requires it) but the route ignores it
    // whenever `cursor` is present — it stays pinned at the filler value `1`,
    // never incremented, which is what distinguishes cursor-mode from
    // counting pages.
    expect(threadsMock.mock.calls[1]?.[0]).toMatchObject({ page: 1 });
    // The store said there's nothing left after the second page.
    expect(result.current.hasNextPage).toBe(false);
  });

  it('stops paging once the store returns nextCursor: null, even if totalCount looks off', async () => {
    threadsMock.mockResolvedValue({ data: { threads: [{ threadId: 't1' }], totalCount: 50, nextCursor: null } });
    const client = newClient();

    const { result } = renderHook(
      () => useInfiniteMailLabelThreads({ accountId: 'macc_1', labelSlug: 'inbox' }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('falls back to counting pages when the response has no nextCursor field at all', async () => {
    // Legacy shape: no `nextCursor` key in the response.
    threadsMock
      .mockResolvedValueOnce({ data: { threads: new Array(25).fill({ threadId: 't' }), totalCount: 30 } })
      .mockResolvedValueOnce({ data: { threads: new Array(5).fill({ threadId: 't' }), totalCount: 30 } });
    const client = newClient();

    const { result } = renderHook(
      () => useInfiniteMailLabelThreads({ accountId: 'macc_1', labelSlug: 'inbox' }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    expect(threadsMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('keeps search filters out of the identity used for page params but in every request', async () => {
    threadsMock.mockResolvedValue({ data: { threads: [], totalCount: 0, nextCursor: null } });
    const client = newClient();

    renderHook(
      () => useInfiniteMailLabelThreads({ accountId: 'macc_1', labelSlug: 'inbox', from: 'a@b.com' }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(threadsMock).toHaveBeenCalled());
    expect(threadsMock).toHaveBeenCalledWith(expect.objectContaining({ from: 'a@b.com' }));
  });
});

describe('useMailMessagesByCounterparty', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it('queries by counterparty, not by search', async () => {
    listMock.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
    const client = newClient();

    const { result } = renderHook(() => useMailMessagesByCounterparty('person@example.com'), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(listMock).toHaveBeenCalledWith({ counterparty: 'person@example.com', limit: 100 });
    expect(listMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: expect.anything() }));
  });

  it('stays disabled without an email', () => {
    const client = newClient();
    renderHook(() => useMailMessagesByCounterparty(undefined), { wrapper: createWrapper(client) });
    expect(listMock).not.toHaveBeenCalled();
  });
});

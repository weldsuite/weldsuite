import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: getMock }) }),
}));

import { useWorkspaceMemberDirectory } from './use-settings-queries';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('useWorkspaceMemberDirectory', () => {
  it('follows every cursor page of the member directory', async () => {
    getMock
      .mockResolvedValueOnce({
        data: [{ userId: 'user_ada', picture: 'https://cdn.test/ada.png' }],
        pagination: { totalCount: 2, hasMore: true, cursor: 'c1' },
      })
      .mockResolvedValueOnce({
        data: [{ userId: 'user_grace', picture: null }],
        pagination: { totalCount: 2, hasMore: false, cursor: null },
      });
    const { result } = renderHook(() => useWorkspaceMemberDirectory(), { wrapper });

    await waitFor(() => expect(result.current.data?.data).toHaveLength(2));
    expect(getMock).toHaveBeenNthCalledWith(1, '/team-members?limit=100&memberType=all');
    expect(getMock).toHaveBeenNthCalledWith(2, '/team-members?limit=100&memberType=all&cursor=c1');
  });

  it('serves a fresh directory from cache for the stale time it is given', async () => {
    getMock.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
    const first = renderHook(() => useWorkspaceMemberDirectory(true, { staleTime: 60_000 }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    renderHook(() => useWorkspaceMemberDirectory(true, { staleTime: 60_000 }), { wrapper });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while disabled', () => {
    renderHook(() => useWorkspaceMemberDirectory(false), { wrapper });
    expect(getMock).not.toHaveBeenCalled();
  });
});

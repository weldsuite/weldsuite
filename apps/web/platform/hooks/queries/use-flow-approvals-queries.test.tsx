import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, orgId: 'org_1' as string | null },
  getMyReviewsCount: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ flowApprovals: { getMyReviewsCount: state.getMyReviewsCount } }),
}));

import { flowApprovalKeys, useMyReviewsCount } from './use-flow-approvals-queries';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

describe('useMyReviewsCount', () => {
  beforeEach(() => {
    state.auth = { isLoaded: true, isSignedIn: true, orgId: 'org_1' };
    state.getMyReviewsCount.mockReset();
  });

  it('is the count of the one cheap request', async () => {
    state.getMyReviewsCount.mockResolvedValue({ data: { count: 4, overdue: 1 } });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    expect(result.current.data).toBe(0);
    await waitFor(() => expect(result.current.data).toBe(4));
    expect(state.getMyReviewsCount).toHaveBeenCalledTimes(1);
  });

  it('does not ask while signed out or without a workspace', async () => {
    const { Wrapper } = wrapper();
    state.auth = { isLoaded: true, isSignedIn: false, orgId: null };
    const signedOut = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    state.auth = { isLoaded: true, isSignedIn: true, orgId: null };
    const noWorkspace = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    state.auth = { isLoaded: false, isSignedIn: false, orgId: null };
    const loading = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.getMyReviewsCount).not.toHaveBeenCalled();
    expect([signedOut, noWorkspace, loading].map((hook) => hook.result.current.data)).toEqual([0, 0, 0]);
  });

  it('never throws: a failing request reads as 0', async () => {
    state.getMyReviewsCount.mockRejectedValue(new Error('offline'));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    await waitFor(() => expect(client.getQueryState(flowApprovalKeys.count())?.status).toBe('success'));
    expect(result.current.data).toBe(0);
  });

  it('keeps the answer for a minute', async () => {
    state.getMyReviewsCount.mockResolvedValue({ data: { count: 2, overdue: 0 } });
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useMyReviewsCount(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBe(2));
    const query = client.getQueryCache().find({ queryKey: flowApprovalKeys.count() });
    expect(query?.observers[0]?.options.staleTime).toBe(60_000);
  });
});

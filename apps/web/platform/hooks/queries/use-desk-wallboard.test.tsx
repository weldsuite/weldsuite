/**
 * The wallboard query: the team goes into the request, and a failed refresh
 * keeps the last numbers instead of blanking the board.
 */

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ getWallboard: vi.fn(), getPhoneReport: vi.fn() }));

vi.mock('@/lib/api/domains/welddesk', () => ({ helpdeskWorkerApi: api }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));

import { deskWallboardKeys, useDeskWallboard } from './use-desk-reports-queries';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

describe('useDeskWallboard', () => {
  it('asks for the team, or for all teams', async () => {
    api.getWallboard.mockResolvedValue({ generatedAt: 'now' });
    const { Wrapper } = wrapper();
    const team = renderHook(() => useDeskWallboard('dept_a'), { wrapper: Wrapper });
    await waitFor(() => expect(team.result.current.isSuccess).toBe(true));
    expect(api.getWallboard).toHaveBeenLastCalledWith('dept_a');

    const all = renderHook(() => useDeskWallboard(null), { wrapper: Wrapper });
    await waitFor(() => expect(all.result.current.isSuccess).toBe(true));
    expect(api.getWallboard).toHaveBeenLastCalledWith(undefined);
  });

  it('keys the board per team under the helpdesk reports keys', () => {
    expect(deskWallboardKeys.board(null)).toEqual(['helpdesk', 'reports', 'wallboard', 'all']);
    expect(deskWallboardKeys.board('dept_a')).toEqual(['helpdesk', 'reports', 'wallboard', 'dept_a']);
  });

  it('polls every 15 seconds in or out of full screen, regardless of idleness, and only while the tab is visible', async () => {
    api.getWallboard.mockResolvedValue({ generatedAt: 'now' });
    const client = new QueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useDeskWallboard(null), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const options = client.getQueryCache().find({ queryKey: deskWallboardKeys.board(null) })?.observers[0]?.options;
    expect(options?.refetchInterval).toBe(15_000);
    // False is react-query's "pause while the tab is hidden"; nothing here reads user activity.
    expect(options?.refetchIntervalInBackground).toBe(false);
  });

  it('keeps the last numbers when a refresh fails', async () => {
    api.getWallboard.mockResolvedValueOnce({ generatedAt: 'first' });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useDeskWallboard(null), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ generatedAt: 'first' }));

    // Reading isError before the refresh makes the observer track it, as the page does.
    expect(result.current.isError).toBe(false);
    api.getWallboard.mockRejectedValue(new Error('offline'));
    void result.current.refetch();
    // The hook retries a failed fetch once, a second later, before it reports the failure.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
    expect(result.current.data).toEqual({ generatedAt: 'first' });
  });
});

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ post: mocks.post }) }),
}));

import { useRepairLiveUpdates } from './use-connector-queries';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useRepairLiveUpdates', () => {
  it('posts to the connection’s live-updates route and refreshes the connection', async () => {
    mocks.post.mockResolvedValue({ data: { connection: { id: 'cc_mb', webhookCount: 1 }, warning: null } });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRepairLiveUpdates(), { wrapper: wrapper(client) });

    let answer: unknown;
    await act(async () => {
      answer = await result.current.mutateAsync('cc_mb');
    });

    expect(mocks.post).toHaveBeenCalledWith('/connectors/connections/cc_mb/live-updates', {});
    expect(answer).toEqual({ data: { connection: { id: 'cc_mb', webhookCount: 1 }, warning: null } });
    expect(invalidate).toHaveBeenCalled();
  });
});

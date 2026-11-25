import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const post = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ post }) }),
}));

import { useShipWeldstashPickList, weldstashKeys } from './use-weldstash-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { invalidate, ...renderHook(() => useShipWeldstashPickList(), { wrapper }) };
}

describe('useShipWeldstashPickList', () => {
  it('posts to the ship endpoint and refreshes the pick lists, the parcels and the shipping data', async () => {
    post.mockResolvedValue({ data: { id: 'pl_1', status: 'shipped', shipmentId: null, parcelId: null } });
    const { result, invalidate } = setup();

    await act(async () => {
      await result.current.mutateAsync('pl_1');
    });

    expect(post).toHaveBeenCalledWith('/pick-lists/pl_1/ship', {});
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual([
      weldstashKeys.pickLists(),
      weldstashKeys.pickList('pl_1'),
      ['weldstash', 'parcels'],
      ['weldstash', 'shipping'],
    ]);
  });

  it('refreshes nothing when shipping fails', async () => {
    post.mockRejectedValue(new Error('not packed'));
    const { result, invalidate } = setup();

    await act(async () => {
      await expect(result.current.mutateAsync('pl_2')).rejects.toThrow('not packed');
    });

    expect(invalidate).not.toHaveBeenCalled();
  });
});

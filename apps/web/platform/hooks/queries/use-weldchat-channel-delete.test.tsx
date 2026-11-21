import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import {
  isChannelGoneError,
  useChannel,
  useDeleteChannel,
  weldchatKeys,
  type ChatChannel,
} from './use-weldchat-queries';

const getMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({
      get: (...args: unknown[]) => getMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    }),
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ userId: 'user_1' }),
  useUser: () => ({ user: null }),
}));

const channel = { id: 'ch_1', name: 'general', type: 'public' } as unknown as ChatChannel;
const other = { id: 'ch_2', name: 'random', type: 'public' } as unknown as ChatChannel;

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('a deleted WeldChat channel', () => {
  beforeEach(() => {
    getMock.mockReset();
    deleteMock.mockReset();
  });

  it('settles on the 404 without retrying, keeping the stale data for the page to ignore', async () => {
    getMock.mockResolvedValueOnce({ data: channel }).mockRejectedValue(new ApiError('Not found', 404));
    const client = newClient();
    // Read `error` like the channel page does, so the hook re-renders on it
    // (TanStack only re-renders for the result fields a component reads).
    const { result } = renderHook(
      () => {
        const query = useChannel('ch_1');
        return { data: query.data, error: query.error, refetch: query.refetch };
      },
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.data?.data.id).toBe('ch_1'));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(isChannelGoneError(result.current.error)).toBe(true));
    // TanStack keeps the last good data: the channel page must check the error.
    expect(result.current.data?.data.id).toBe('ch_1');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('does not treat other failures as gone', () => {
    expect(isChannelGoneError(new ApiError('Forbidden', 403))).toBe(false);
    expect(isChannelGoneError(new Error('offline'))).toBe(false);
  });

  it('drops the channel from the cached list and forgets its detail on delete', async () => {
    deleteMock.mockResolvedValue(undefined);
    getMock.mockReturnValue(new Promise(() => {}));
    const client = newClient();
    client.setQueryData(weldchatKeys.channels(), { data: [channel, other] });
    client.setQueryData(weldchatKeys.channelDetail('ch_1'), { data: channel });
    const { result } = renderHook(() => useDeleteChannel(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync('ch_1');
    });

    const list = client.getQueryData<{ data: ChatChannel[] }>(weldchatKeys.channels());
    expect(list?.data.map((c) => c.id)).toEqual(['ch_2']);
    expect(client.getQueryData(weldchatKeys.channelDetail('ch_1'))).toBeUndefined();
  });
});

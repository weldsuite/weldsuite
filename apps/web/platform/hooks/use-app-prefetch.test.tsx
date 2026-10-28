import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAppPrefetch } from './use-app-prefetch';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import { preferencesKey } from '@/hooks/queries/use-settings-queries';

const getMock = vi.fn();
const routerPrefetchMock = vi.fn();

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { id: 'user_1' } }),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ get: (...args: unknown[]) => getMock(...args) }),
  }),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ prefetch: routerPrefetchMock }),
}));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useAppPrefetch — weldmail', () => {
  const accounts = [
    { id: 'macc_1', isDefault: true },
    { id: 'macc_2', isDefault: false },
  ];

  beforeEach(() => {
    getMock.mockReset();
    routerPrefetchMock.mockReset();
    getMock.mockImplementation((url: string) => {
      if (url === '/mail-accounts') return Promise.resolve({ data: accounts });
      if (url.startsWith('/mail-labels/threads')) return Promise.resolve({ data: { threads: [], totalCount: 0 } });
      if (url.startsWith('/mail-labels?')) return Promise.resolve({ data: [] });
      if (url.startsWith('/mail-messages/stats')) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  });

  it("warms the pinned default account's inbox, labels and the label route chunk", async () => {
    const client = newClient();
    client.setQueryData(preferencesKey, { uiPreferences: { mailDefaultAccountId: 'macc_2' } });

    const { result } = renderHook(() => useAppPrefetch(), { wrapper: createWrapper(client) });
    act(() => result.current.prefetch('weldmail'));

    await waitFor(() => expect(routerPrefetchMock).toHaveBeenCalledWith('/weldmail/macc_2/inbox'));

    expect(getMock).toHaveBeenCalledWith('/mail-accounts');
    expect(getMock).toHaveBeenCalledWith('/mail-labels/threads?accountId=macc_2&labelSlug=inbox&pageSize=25&page=1');
    expect(getMock).toHaveBeenCalledWith('/mail-labels?accountId=macc_2');
    expect(
      client.getQueryData(mailKeys.threadsByLabel({ accountId: 'macc_2', labelSlug: 'inbox', pageSize: 25 })),
    ).toBeDefined();
    expect(client.getQueryData(mailKeys.labels('macc_2'))).toBeDefined();
  });

  it('falls back to the workspace default account without a pinned/last preference', async () => {
    const client = newClient();

    const { result } = renderHook(() => useAppPrefetch(), { wrapper: createWrapper(client) });
    act(() => result.current.prefetch('weldmail'));

    await waitFor(() => expect(routerPrefetchMock).toHaveBeenCalledWith('/weldmail/macc_1/inbox'));
  });

  it('does nothing past the accounts fetch when the workspace has no mailbox', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/mail-accounts') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    const client = newClient();

    const { result } = renderHook(() => useAppPrefetch(), { wrapper: createWrapper(client) });
    act(() => result.current.prefetch('weldmail'));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/mail-accounts'));
    expect(routerPrefetchMock).not.toHaveBeenCalled();
  });
});

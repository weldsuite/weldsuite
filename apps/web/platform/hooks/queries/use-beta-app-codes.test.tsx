import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, dehydrate, hydrate } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useBetaAppCodes } from './use-settings-queries';

const getMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ get: (...args: unknown[]) => getMock(...args) }),
  }),
}));

const BETA_APPS_KEY = ['settings', 'beta-apps'];

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useBetaAppCodes', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: ['weldsocial', 'weldagent'] });
  });

  it('keeps working after the cache is persisted to JSON and rehydrated', async () => {
    const first = newClient();
    const { result } = renderHook(() => useBetaAppCodes(), { wrapper: createWrapper(first) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.has('weldsocial')).toBe(true);

    // What PersistQueryClientProvider does across a page reload.
    const persisted = JSON.parse(JSON.stringify(dehydrate(first)));
    const second = newClient();
    hydrate(second, persisted);

    const { result: rehydrated } = renderHook(() => useBetaAppCodes(), { wrapper: createWrapper(second) });
    expect(rehydrated.current.data?.has('weldsocial')).toBe(true);
    expect(rehydrated.current.data?.has('weldagent')).toBe(true);
    expect(rehydrated.current.data?.has('weldcrm')).toBe(false);
  });

  it('tolerates the `{}` a Set was serialised to by older builds', () => {
    const client = newClient();
    client.setQueryData(BETA_APPS_KEY, {});

    const { result } = renderHook(() => useBetaAppCodes(), { wrapper: createWrapper(client) });
    expect(result.current.data?.has('weldagent')).toBe(false);
  });
});

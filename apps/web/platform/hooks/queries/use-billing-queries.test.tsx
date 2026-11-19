import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: mocks.get }) }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => path }));

import { billingKeys, useBillingVat, useRefreshBillingVat } from './use-billing-queries';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const VAT = {
  missing: [],
  country: 'BE',
  vatNumber: 'BE0123456789',
  vatNumberStatus: 'valid',
  vat: { treatment: 'reverse_charge', rateBps: 0, country: 'BE' },
};

describe('useBillingVat', () => {
  it('reads GET /billing/vat', async () => {
    mocks.get.mockResolvedValue({ data: VAT });
    const client = new QueryClient();
    const { result } = renderHook(() => useBillingVat(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.data).toEqual(VAT));
    expect(mocks.get).toHaveBeenCalledWith('/billing/vat');
  });

  it('asks nothing while disabled (Global has no such route)', () => {
    mocks.get.mockReset();
    const client = new QueryClient();
    renderHook(() => useBillingVat(false), { wrapper: wrapper(client) });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('useRefreshBillingVat', () => {
  it('marks the VAT answer stale', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRefreshBillingVat(), { wrapper: wrapper(client) });

    act(() => result.current());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.vat() });
  });
});

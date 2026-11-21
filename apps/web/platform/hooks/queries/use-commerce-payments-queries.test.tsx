import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));

import {
  commercePaymentKeys,
  isOauthAvailable,
  useAuthorizeMollie,
  useConnectMollieApiKey,
  useCreatePaymentLink,
  useCreateRefund,
  useDisconnectPayments,
  useMollieProfiles,
  useOrderPayments,
  usePaymentConnection,
  useRetryOrderInvoice,
  useUpdatePaymentConnection,
} from './use-commerce-payments-queries';
import { commerceKeys } from './use-commerce-queries';
import { commerceOrderKeys } from './use-commerce-orders-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: null });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue(undefined);
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

describe('query keys', () => {
  it('sit under weldcommerce / payments, the prefix the realtime event invalidates', () => {
    expect(commercePaymentKeys.all()).toEqual(['weldcommerce', 'payments']);
    for (const key of [commercePaymentKeys.connection(), commercePaymentKeys.profiles(), commercePaymentKeys.order('ord_1')]) {
      expect(key.slice(0, 2)).toEqual(['weldcommerce', 'payments']);
    }
  });
});

describe('isOauthAvailable', () => {
  it('reads the connection, or the meta when nothing is connected', () => {
    expect(isOauthAvailable({ data: { oauthAvailable: true } as never })).toBe(true);
    expect(isOauthAvailable({ data: null, meta: { oauthAvailable: true } })).toBe(true);
    expect(isOauthAvailable({ data: null, meta: { oauthAvailable: false } })).toBe(false);
    expect(isOauthAvailable({ data: null })).toBe(false);
    expect(isOauthAvailable(undefined)).toBe(false);
  });
});

describe('connection reads', () => {
  it('reads the connection and the profiles from their paths', async () => {
    renderHook(() => usePaymentConnection(), { wrapper });
    renderHook(() => useMollieProfiles(), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const paths = api.get.mock.calls.map(([path]) => path);
    expect(paths).toContain('/commerce-payments/connection');
    expect(paths).toContain('/commerce-payments/connection/profiles');
  });

  it('does not ask when disabled', () => {
    renderHook(() => usePaymentConnection(false), { wrapper });
    renderHook(() => useMollieProfiles(false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('connection writes', () => {
  it('asks for the authorize URL and changes nothing in the cache', async () => {
    api.post.mockResolvedValue({ data: { url: 'https://my.mollie.com/oauth2/authorize' } });
    const seen = invalidated();
    const { result } = renderHook(() => useAuthorizeMollie(), { wrapper });
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync(undefined);
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-payments/connection/mollie/authorize', {});
    expect(res).toEqual({ data: { url: 'https://my.mollie.com/oauth2/authorize' } });
    expect(seen()).toEqual([]);
  });

  it('sends the key and the profile to the api-key route and refreshes the payments', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useConnectMollieApiKey(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ apiKey: 'test_abc', profileId: 'pfl_1' });
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-payments/connection/mollie/api-key', { apiKey: 'test_abc', profileId: 'pfl_1' });
    expect(seen()).toContainEqual(commercePaymentKeys.all());
  });

  it('patches the connection and refreshes the payments', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useUpdatePaymentConnection(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ testmode: true });
    });
    expect(api.patch).toHaveBeenCalledWith('/commerce-payments/connection', { testmode: true });
    expect(seen()).toContainEqual(commercePaymentKeys.all());
  });

  it('disconnects and refreshes the payments', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useDisconnectPayments(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(api.delete).toHaveBeenCalledWith('/commerce-payments/connection');
    expect(seen()).toContainEqual(commercePaymentKeys.all());
  });
});

describe('an order’s payments', () => {
  it('reads them from the order, not without an id', async () => {
    renderHook(() => useOrderPayments('ord_1'), { wrapper });
    renderHook(() => useOrderPayments(''), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledWith('/orders/ord_1/payments');
  });

  it('creates a payment link and refreshes the payments, the orders and the overview', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useCreatePaymentLink(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('ord_1');
    });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/payment-link', {});
    expect(seen()).toEqual(
      expect.arrayContaining([commercePaymentKeys.order('ord_1'), commerceOrderKeys.orders(), commerceKeys.overview()]),
    );
  });

  it('creates a refund with the amount and the reason and refreshes the same', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useCreateRefund(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: 'ord_1', data: { amount: '5.00', reason: 'Damaged' } });
    });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/refunds', { amount: '5.00', reason: 'Damaged' });
    expect(seen()).toEqual(
      expect.arrayContaining([commercePaymentKeys.order('ord_1'), commerceOrderKeys.orders(), commerceKeys.overview()]),
    );
  });

  it('retries the invoice and refreshes the order', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useRetryOrderInvoice(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('ord_1');
    });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/invoice', {});
    expect(seen()).toContainEqual(commerceOrderKeys.orders());
  });

  it('does not refresh anything when the call fails', async () => {
    api.post.mockRejectedValue(new Error('nope'));
    const seen = invalidated();
    const { result } = renderHook(() => useCreateRefund(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: 'ord_1', data: { amount: '1.00' } }).catch(() => undefined);
    });
    expect(seen()).toEqual([]);
  });
});

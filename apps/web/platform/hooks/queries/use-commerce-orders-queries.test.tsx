import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));

import {
  commerceOrderKeys,
  useCancelCommerceOrder,
  useCommerceDiscount,
  useCommerceDiscountRedemptions,
  useCommerceOrder,
  useCommerceSettings,
  useCreateCommerceDiscount,
  useCreateCommerceOrder,
  useDeleteCommerceDiscount,
  useInfiniteCommerceDiscounts,
  useInfiniteCommerceOrders,
  useMarkCommerceOrderPaid,
  useOrderQuote,
  useProductsByIds,
  useUpdateCommerceDiscount,
  useUpdateCommerceOrder,
  useUpdateCommerceSettings,
  type OrderInput,
} from './use-commerce-orders-queries';
import { commerceKeys } from './use-commerce-queries';
import { weldstashKeys } from './use-weldstash-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue(undefined);
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

describe('order reads', () => {
  it('lists orders with the filters and a cursor, and pages on', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 'ord_1' }], pagination: { totalCount: 2, hasMore: true, cursor: 'c2' } });
    const { result } = renderHook(
      () => useInfiniteCommerceOrders({ limit: 50, status: 'pending', from: '2026-11-01', search: 'Acme' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const first = String(api.get.mock.calls[0][0]);
    expect(first.startsWith('/orders?')).toBe(true);
    expect(first).toContain('status=pending');
    expect(first).toContain('from=2026-11-01');
    expect(first).toContain('search=Acme');
    expect(first).not.toContain('cursor');

    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(String(api.get.mock.calls[1][0])).toContain('cursor=c2');
  });

  it('reads one order, and nothing without an id', async () => {
    const { result } = renderHook(() => useCommerceOrder('ord_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/orders/ord_1');

    renderHook(() => useCommerceOrder(''), { wrapper });
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('useOrderQuote', () => {
  const input: OrderInput = { currency: 'EUR', items: [{ productId: 'prod_1', quantity: 2 }] };

  it('posts the order to /orders/quote and returns the priced quote', async () => {
    api.post.mockResolvedValue({ data: { total: '20.00', lines: [], discountProblem: null } });
    const { result } = renderHook(() => useOrderQuote(input), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith('/orders/quote', input);
    expect(result.current.data?.data.total).toBe('20.00');
  });

  it('asks nothing while there is nothing to price', () => {
    renderHook(() => useOrderQuote(null), { wrapper });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps the previous quote on screen while the next one loads', async () => {
    api.post.mockResolvedValueOnce({ data: { total: '20.00' } });
    const { result, rerender } = renderHook(({ value }) => useOrderQuote(value), {
      wrapper,
      initialProps: { value: input as OrderInput | null },
    });
    await waitFor(() => expect(result.current.data?.data.total).toBe('20.00'));

    api.post.mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ value: { ...input, shippingTotal: '5.00' } });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data?.data.total).toBe('20.00');
  });
});

describe('order writes', () => {
  it('creates an order and refreshes the orders, the overview and the discounts', async () => {
    const keys = invalidated();
    api.post.mockResolvedValue({ data: { id: 'ord_9', orderNumber: 'WC-1001' } });
    const { result } = renderHook(() => useCreateCommerceOrder(), { wrapper });
    const body: OrderInput = { currency: 'EUR', items: [{ name: 'Setup', quantity: 1, unitPrice: '50.00' }] };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(api.post).toHaveBeenCalledWith('/orders', body);
    expect(keys()).toEqual(
      expect.arrayContaining([commerceOrderKeys.orders(), commerceKeys.overview(), commerceOrderKeys.discounts()]),
    );
  });

  it('patches, cancels and marks paid on the order, each refreshing the orders', async () => {
    const keys = invalidated();
    const update = renderHook(() => useUpdateCommerceOrder(), { wrapper });
    const cancel = renderHook(() => useCancelCommerceOrder(), { wrapper });
    const paid = renderHook(() => useMarkCommerceOrderPaid(), { wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ id: 'ord_1', data: { status: 'confirmed' } });
      await cancel.result.current.mutateAsync({ id: 'ord_1', reason: 'Duplicate' });
      await cancel.result.current.mutateAsync({ id: 'ord_1' });
      await paid.result.current.mutateAsync({ id: 'ord_1', data: { paymentMethod: 'Bank transfer' } });
    });
    expect(api.patch).toHaveBeenCalledWith('/orders/ord_1', { status: 'confirmed' });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/cancel', { reason: 'Duplicate' });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/cancel', {});
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/mark-paid', { paymentMethod: 'Bank transfer' });
    expect(keys().filter((key) => JSON.stringify(key) === JSON.stringify(commerceOrderKeys.orders()))).toHaveLength(4);
  });
});

describe('discount hooks', () => {
  it('lists, reads and pages the redemptions of a discount', async () => {
    renderHook(() => useInfiniteCommerceDiscounts({ limit: 50, effectiveStatus: 'active' }), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(String(api.get.mock.calls[0][0])).toContain('/discounts?');
    expect(String(api.get.mock.calls[0][0])).toContain('effectiveStatus=active');

    renderHook(() => useCommerceDiscount('dsc_1'), { wrapper });
    renderHook(() => useCommerceDiscountRedemptions('dsc_1'), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.get).toHaveBeenCalledWith('/discounts/dsc_1');
    expect(String(api.get.mock.calls[2][0])).toContain('/discounts/dsc_1/redemptions');
  });

  it('creates, updates and deletes, refreshing the discounts', async () => {
    const keys = invalidated();
    const create = renderHook(() => useCreateCommerceDiscount(), { wrapper });
    const update = renderHook(() => useUpdateCommerceDiscount(), { wrapper });
    const remove = renderHook(() => useDeleteCommerceDiscount(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ name: 'Spring', code: 'SPRING', type: 'percentage', value: '10' });
      await update.result.current.mutateAsync({ id: 'dsc_1', data: { status: 'archived' } });
      await remove.result.current.mutateAsync('dsc_1');
    });
    expect(api.post).toHaveBeenCalledWith('/discounts', expect.objectContaining({ code: 'SPRING' }));
    expect(api.patch).toHaveBeenCalledWith('/discounts/dsc_1', { status: 'archived' });
    expect(api.delete).toHaveBeenCalledWith('/discounts/dsc_1');
    expect(keys()).toEqual([commerceOrderKeys.discounts(), commerceOrderKeys.discounts(), commerceOrderKeys.discounts()]);
  });

  it('reads the products behind product ids through the shared product cache', async () => {
    api.get.mockImplementation(async (path: string) => ({ data: { id: path.split('/').pop(), name: `Name ${path.split('/').pop()}` } }));
    const { result } = renderHook(() => useProductsByIds(['prod_1', 'prod_2']), { wrapper });
    await waitFor(() => expect(result.current.every((query) => query.isSuccess)).toBe(true));
    expect(result.current.map((query) => query.data?.data.name)).toEqual(['Name prod_1', 'Name prod_2']);
    expect(client.getQueryData(weldstashKeys.product('prod_1'))).toBeDefined();
  });
});

describe('settings hooks', () => {
  it('reads the settings, only when asked to', async () => {
    api.get.mockResolvedValue({ data: { orderNumberPrefix: 'WC-', nextOrderNumber: 1001, defaultCurrency: 'EUR' } });
    renderHook(() => useCommerceSettings(false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useCommerceSettings(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/commerce-settings');
  });

  it('patches the settings and refreshes them', async () => {
    const keys = invalidated();
    const { result } = renderHook(() => useUpdateCommerceSettings(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ nextOrderNumber: 2000 });
    });
    expect(api.patch).toHaveBeenCalledWith('/commerce-settings', { nextOrderNumber: 2000 });
    expect(keys()).toEqual([commerceOrderKeys.settings()]);
  });
});

describe('keys', () => {
  it('sit under the weldcommerce root the realtime sync map refreshes', () => {
    expect(commerceOrderKeys.orders()).toEqual(['weldcommerce', 'orders']);
    expect(commerceOrderKeys.discounts()).toEqual(['weldcommerce', 'discounts']);
    expect(commerceOrderKeys.settings()).toEqual(['weldcommerce', 'settings']);
    expect(commerceOrderKeys.order('o1').slice(0, 2)).toEqual(['weldcommerce', 'orders']);
    expect(commerceOrderKeys.redemptions('d1').slice(0, 2)).toEqual(['weldcommerce', 'discounts']);
  });
});

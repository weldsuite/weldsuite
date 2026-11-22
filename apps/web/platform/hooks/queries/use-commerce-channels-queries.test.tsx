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
  commerceChannelKeys,
  useChannelKeys,
  useCommerceChannels,
  useCreateChannelKey,
  useCreateCommerceChannel,
  useCreateShippingRate,
  useDeleteCommerceChannel,
  useDeleteShippingRate,
  useProductPrices,
  useReorderShippingRates,
  useRevokeChannelKey,
  useRotateChannelKey,
  useSaveProductPrices,
  useShippingRates,
  useUpdateChannelKey,
  useUpdateCommerceChannel,
  useUpdateShippingRate,
} from './use-commerce-channels-queries';
import { commerceKeys } from './use-commerce-queries';
import { commerceOrderKeys } from './use-commerce-orders-queries';
import { weldstashKeys } from './use-weldstash-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: [] });
  api.delete.mockResolvedValue(undefined);
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

describe('channel reads', () => {
  it('lists channels with the filters on the query string', async () => {
    const { result } = renderHook(() => useCommerceChannels({ status: 'active', search: 'shop' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = String(api.get.mock.calls[0][0]);
    expect(url.startsWith('/commerce-channels?')).toBe(true);
    expect(url).toContain('status=active');
    expect(url).toContain('search=shop');
  });

  it('reads the keys, the shipping rates and the prices from their own paths', async () => {
    renderHook(() => useChannelKeys('ch_1'), { wrapper });
    renderHook(() => useShippingRates('ch_1'), { wrapper });
    renderHook(() => useProductPrices('prod_1'), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    const paths = api.get.mock.calls.map(([path]) => path);
    expect(paths).toContain('/commerce-channels/ch_1/keys');
    expect(paths).toContain('/commerce-channels/ch_1/shipping-rates');
    expect(paths).toContain('/products/prod_1/prices');
  });

  it('does not ask without an id or when disabled', () => {
    renderHook(() => useChannelKeys(''), { wrapper });
    renderHook(() => useProductPrices('prod_1', false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('channel writes', () => {
  it('creates, updates and archives a channel, refreshing the channels and the orders that name them', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({ create: useCreateCommerceChannel(), update: useUpdateCommerceChannel(), remove: useDeleteCommerceChannel() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ name: 'Shop', type: 'storefront' });
      await result.current.update.mutateAsync({ id: 'ch_1', data: { currency: 'EUR' } });
      await result.current.remove.mutateAsync('ch_1');
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-channels', { name: 'Shop', type: 'storefront' });
    expect(api.patch).toHaveBeenCalledWith('/commerce-channels/ch_1', { currency: 'EUR' });
    expect(api.delete).toHaveBeenCalledWith('/commerce-channels/ch_1');
    expect(keys()).toContainEqual(commerceChannelKeys.channels());
    expect(keys()).toContainEqual(commerceOrderKeys.orders());
  });
});

describe('key writes', () => {
  it('returns the secret of a new key to the caller and refreshes the keys and the channel counts', async () => {
    api.post.mockResolvedValue({ data: { key: { id: 'k1' }, secret: 'wcp_abc' } });
    const keys = invalidated();
    const { result } = renderHook(() => useCreateChannelKey(), { wrapper });
    let response: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      response = await result.current.mutateAsync({
        channelId: 'ch_1',
        data: { kind: 'publishable', name: 'Web', allowedOrigins: ['https://shop.example.com'] },
      });
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-channels/ch_1/keys', {
      kind: 'publishable',
      name: 'Web',
      allowedOrigins: ['https://shop.example.com'],
    });
    expect(response?.data.secret).toBe('wcp_abc');
    expect(keys()).toContainEqual(commerceChannelKeys.keys('ch_1'));
    expect(keys()).toContainEqual(commerceChannelKeys.channels());
    // The secret is not put in the cache.
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('wcp_abc');
  });

  it('patches, rotates and revokes a key', async () => {
    const { result } = renderHook(
      () => ({ update: useUpdateChannelKey(), rotate: useRotateChannelKey(), revoke: useRevokeChannelKey() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.update.mutateAsync({ channelId: 'ch_1', keyId: 'k1', data: { name: 'Renamed' } });
      await result.current.rotate.mutateAsync({ channelId: 'ch_1', keyId: 'k1' });
      await result.current.revoke.mutateAsync({ channelId: 'ch_1', keyId: 'k1' });
    });
    expect(api.patch).toHaveBeenCalledWith('/commerce-channels/ch_1/keys/k1', { name: 'Renamed' });
    expect(api.post).toHaveBeenCalledWith('/commerce-channels/ch_1/keys/k1/rotate', {});
    expect(api.post).toHaveBeenCalledWith('/commerce-channels/ch_1/keys/k1/revoke', {});
  });
});

describe('shipping rate writes', () => {
  it('creates, updates, deletes and reorders rates, refreshing only that channel\'s rates', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({
        create: useCreateShippingRate(),
        update: useUpdateShippingRate(),
        remove: useDeleteShippingRate(),
        reorder: useReorderShippingRates(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ channelId: 'ch_1', data: { name: 'Standard', price: '4.95' } });
      await result.current.update.mutateAsync({ channelId: 'ch_1', rateId: 'r1', data: { active: false } });
      await result.current.remove.mutateAsync({ channelId: 'ch_1', rateId: 'r1' });
      await result.current.reorder.mutateAsync({ channelId: 'ch_1', ids: ['r2', 'r1'] });
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-channels/ch_1/shipping-rates', { name: 'Standard', price: '4.95' });
    expect(api.patch).toHaveBeenCalledWith('/commerce-channels/ch_1/shipping-rates/r1', { active: false });
    expect(api.delete).toHaveBeenCalledWith('/commerce-channels/ch_1/shipping-rates/r1');
    expect(api.put).toHaveBeenCalledWith('/commerce-channels/ch_1/shipping-rates/order', { ids: ['r2', 'r1'] });
    expect(keys()).toContainEqual(commerceChannelKeys.shippingRates('ch_1'));
  });
});

describe('product prices', () => {
  it('saves the whole set and refreshes the prices and the product rows', async () => {
    const keys = invalidated();
    const { result } = renderHook(() => useSaveProductPrices(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ productId: 'prod_1', prices: [{ currency: 'USD', price: '12.00' }] });
    });
    expect(api.put).toHaveBeenCalledWith('/products/prod_1/prices', { prices: [{ currency: 'USD', price: '12.00' }] });
    expect(keys()).toContainEqual(commerceKeys.product('prod_1').concat('prices'));
    expect(keys()).toContainEqual(weldstashKeys.product('prod_1'));
    expect(keys()).toContainEqual(weldstashKeys.products());
  });
});

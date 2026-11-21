/**
 * WeldCommerce phase 4 query hooks: sales channels, their storefront keys and
 * shipping rates, and a product's prices per currency. Served by the Rust
 * `commerce` module (EU edition); the contract is `/commerce-channels`
 * (+ `/keys`, `/shipping-rates`) and `/products/:id/prices`.
 *
 * - Channels:  GET / POST /commerce-channels, GET / PATCH / DELETE /:id
 * - Keys:      GET / POST /:id/keys, PATCH /:id/keys/:keyId,
 *              POST /:id/keys/:keyId/rotate and /revoke. The secret comes back
 *              once, from the create and the rotate call, and is never cached:
 *              the mutations return it to the caller and nothing else.
 * - Shipping:  GET / POST /:id/shipping-rates, PATCH / DELETE /:rateId,
 *              PUT /:id/shipping-rates/order
 * - Prices:    GET / PUT /products/:id/prices (the whole set at once)
 *
 * Money is a decimal string with two decimals (`"4.95"`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';
import { weldstashKeys } from '@/hooks/queries/use-weldstash-queries';
import { commerceKeys } from '@/hooks/queries/use-commerce-queries';
import { commerceOrderKeys } from '@/hooks/queries/use-commerce-orders-queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelType = 'storefront' | 'manual' | 'shopify' | 'woocommerce';
export type ChannelAudience = 'b2c' | 'b2b';
export type ChannelStatus = 'draft' | 'active' | 'archived';
export type ChannelPaymentMethod = 'mollie' | 'invoice';

export interface CommerceChannel {
  id: string;
  name: string;
  type: ChannelType;
  audience: ChannelAudience;
  status: ChannelStatus;
  /** ISO 4217. */
  currency: string;
  pricesIncludeTax: boolean;
  /** ISO 3166-1 alpha-2, EU member states only. */
  sellingCountries: string[];
  guestCheckout: boolean;
  paymentMethods: ChannelPaymentMethod[];
  connectionId: string | null;
  activeKeyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelListParams {
  type?: string;
  status?: string;
  search?: string;
}

/** Create body; an update sends any of these. */
export interface ChannelInput {
  name?: string;
  type?: ChannelType;
  audience?: ChannelAudience;
  status?: ChannelStatus;
  currency?: string;
  pricesIncludeTax?: boolean;
  sellingCountries?: string[];
  guestCheckout?: boolean;
  paymentMethods?: ChannelPaymentMethod[];
  connectionId?: string | null;
}

export type ChannelKeyKind = 'publishable' | 'private';

export interface ChannelKey {
  id: string;
  channelId: string;
  kind: ChannelKeyKind;
  name: string;
  /** The first characters of the key, to recognise it by. */
  keyPrefix: string;
  /** Publishable keys only: exact origins such as `https://shop.example.com`. */
  allowedOrigins: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
}

export interface ChannelKeyInput {
  kind: ChannelKeyKind;
  name: string;
  allowedOrigins?: string[];
}

export interface ChannelKeyPatch {
  name?: string;
  allowedOrigins?: string[];
}

/** What a create or a rotate returns: the only time the secret is available. */
export interface ChannelKeySecret {
  key: ChannelKey;
  secret: string;
}

export interface ShippingRate {
  id: string;
  channelId: string;
  zoneName: string;
  /** ISO-2, a subset of the channel's selling countries. */
  countries: string[];
  name: string;
  price: string;
  /** The channel's currency. */
  currency: string;
  /** The subtotal at or above which shipping is free. */
  freeShippingThreshold: string | null;
  position: number;
  active: boolean;
}

export interface ShippingRateInput {
  zoneName?: string;
  countries?: string[];
  name?: string;
  price?: string;
  freeShippingThreshold?: string | null;
  active?: boolean;
}

export interface ProductPrice {
  id: string;
  productId: string;
  /** Null: the price of the product itself. */
  variantId: string | null;
  currency: string;
  price: string;
  compareAtPrice: string | null;
}

export interface ProductPriceInput {
  variantId?: string | null;
  currency: string;
  price: string;
  compareAtPrice?: string | null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const commerceChannelKeys = {
  channels: () => [...commerceKeys.all, 'channels'] as const,
  channelList: (params?: ChannelListParams) => [...commerceChannelKeys.channels(), 'list', params ?? {}] as const,
  channel: (id: string) => [...commerceChannelKeys.channels(), 'detail', id] as const,
  keys: (channelId: string) => [...commerceChannelKeys.channel(channelId), 'keys'] as const,
  shippingRates: (channelId: string) => [...commerceChannelKeys.channel(channelId), 'shipping-rates'] as const,
  productPrices: (productId: string) => [...commerceKeys.product(productId), 'prices'] as const,
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Every channel (a workspace has a handful, so one page). */
export function useCommerceChannels(params: ChannelListParams = {}, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceChannelKeys.channelList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString(params as Record<string, unknown>);
      return client.get<ListResponse<CommerceChannel>>(`/commerce-channels${qs}`);
    },
    enabled,
  });
}

export function useCommerceChannel(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceChannelKeys.channel(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceChannel>>(`/commerce-channels/${id}`);
    },
    enabled: !!id && enabled,
  });
}

/** After a channel write: the channel lists and details, and the orders that show its name. */
function useInvalidateChannels() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: commerceChannelKeys.channels() });
    void qc.invalidateQueries({ queryKey: commerceOrderKeys.orders() });
  };
}

export function useCreateCommerceChannel() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateChannels();
  return useMutation({
    mutationFn: async (data: ChannelInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>('/commerce-channels', data);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateCommerceChannel() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateChannels();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: ChannelInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceChannel>>(`/commerce-channels/${id}`, data);
    },
    onSuccess: invalidate,
  });
}

/** Archiving is the delete: the API soft-deletes the channel and revokes its keys. */
export function useDeleteCommerceChannel() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateChannels();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/commerce-channels/${id}`);
    },
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function useChannelKeys(channelId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceChannelKeys.keys(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<ChannelKey[]>>(`/commerce-channels/${channelId}/keys`);
    },
    enabled: !!channelId && enabled,
  });
}

/** After a key write: the key list, and the channel lists that count the active keys. */
function useInvalidateKeys() {
  const qc = useQueryClient();
  return (channelId: string) => {
    void qc.invalidateQueries({ queryKey: commerceChannelKeys.keys(channelId) });
    void qc.invalidateQueries({ queryKey: commerceChannelKeys.channels() });
  };
}

export function useCreateChannelKey() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: async ({ channelId, data }: { channelId: string; data: ChannelKeyInput }) => {
      const client = await getClient();
      return client.post<DataResponse<ChannelKeySecret>>(`/commerce-channels/${channelId}/keys`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

export function useUpdateChannelKey() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: async ({ channelId, keyId, data }: { channelId: string; keyId: string; data: ChannelKeyPatch }) => {
      const client = await getClient();
      return client.patch<DataResponse<ChannelKey>>(`/commerce-channels/${channelId}/keys/${keyId}`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

/** The old key is revoked at once; the new key's secret is in the response. */
export function useRotateChannelKey() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: async ({ channelId, keyId }: { channelId: string; keyId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<ChannelKeySecret>>(`/commerce-channels/${channelId}/keys/${keyId}/rotate`, {});
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

export function useRevokeChannelKey() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: async ({ channelId, keyId }: { channelId: string; keyId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<ChannelKey>>(`/commerce-channels/${channelId}/keys/${keyId}/revoke`, {});
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

// ---------------------------------------------------------------------------
// Shipping rates
// ---------------------------------------------------------------------------

export function useShippingRates(channelId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceChannelKeys.shippingRates(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<ShippingRate[]>>(`/commerce-channels/${channelId}/shipping-rates`);
    },
    enabled: !!channelId && enabled,
  });
}

function useInvalidateShippingRates() {
  const qc = useQueryClient();
  return (channelId: string) => qc.invalidateQueries({ queryKey: commerceChannelKeys.shippingRates(channelId) });
}

export function useCreateShippingRate() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateShippingRates();
  return useMutation({
    mutationFn: async ({ channelId, data }: { channelId: string; data: ShippingRateInput }) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>(`/commerce-channels/${channelId}/shipping-rates`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

export function useUpdateShippingRate() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateShippingRates();
  return useMutation({
    mutationFn: async ({ channelId, rateId, data }: { channelId: string; rateId: string; data: ShippingRateInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<ShippingRate>>(`/commerce-channels/${channelId}/shipping-rates/${rateId}`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

export function useDeleteShippingRate() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateShippingRates();
  return useMutation({
    mutationFn: async ({ channelId, rateId }: { channelId: string; rateId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/commerce-channels/${channelId}/shipping-rates/${rateId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

/** The new order of the channel's rates: every id, first to last. */
export function useReorderShippingRates() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateShippingRates();
  return useMutation({
    mutationFn: async ({ channelId, ids }: { channelId: string; ids: string[] }) => {
      const client = await getClient();
      return client.put<void>(`/commerce-channels/${channelId}/shipping-rates/order`, { ids });
    },
    onSuccess: (_, vars) => invalidate(vars.channelId),
  });
}

// ---------------------------------------------------------------------------
// Prices per currency
// ---------------------------------------------------------------------------

export function useProductPrices(productId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceChannelKeys.productPrices(productId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<ProductPrice[]>>(`/products/${productId}/prices`);
    },
    enabled: !!productId && enabled,
  });
}

/** Replaces the product's whole price set; rows left out are removed. */
export function useSaveProductPrices() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, prices }: { productId: string; prices: ProductPriceInput[] }) => {
      const client = await getClient();
      return client.put<DataResponse<ProductPrice[]>>(`/products/${productId}/prices`, { prices });
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: commerceChannelKeys.productPrices(vars.productId) });
      void qc.invalidateQueries({ queryKey: weldstashKeys.product(vars.productId) });
      void qc.invalidateQueries({ queryKey: weldstashKeys.products() });
    },
  });
}

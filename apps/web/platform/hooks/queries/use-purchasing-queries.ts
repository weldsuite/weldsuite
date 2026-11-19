/**
 * WeldStash purchasing: purchase orders, their lines, receiving, receipts and
 * product suppliers. Typed domain clients from `@weldsuite/app-api-client`.
 *
 * What runs on every edition: the purchase order header and line CRUD. What
 * only the Rust backend (Kubernetes editions) serves: the status actions,
 * receive, receipts, Send to Odoo and product suppliers. Those hooks stay
 * idle on Global (`isFeatureAvailable('stash-replenishment')`), so no request ever goes to a route
 * that would answer 404.
 */

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DataResponse, ListResponse } from '@weldsuite/app-api-client/types';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import type { ListPurchaseOrdersQuery } from '@weldsuite/app-api-client/domains/purchase-orders';
import type { ListProductSuppliersQuery } from '@weldsuite/app-api-client/domains/product-suppliers';
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrderLineInput,
  MarkPurchaseOrderOrderedInput,
  ReceivePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  UpdatePurchaseOrderLineInput,
} from '@weldsuite/app-api-client/schemas/purchase-orders';
import type {
  CreateProductSupplierInput,
  UpdateProductSupplierInput,
} from '@weldsuite/app-api-client/schemas/product-suppliers';

export const purchasingKeys = {
  all: ['weldstash', 'purchasing'] as const,
  orders: () => [...purchasingKeys.all, 'orders'] as const,
  orderList: (params?: ListPurchaseOrdersQuery) => [...purchasingKeys.orders(), 'list', params ?? {}] as const,
  order: (id: string) => [...purchasingKeys.orders(), 'detail', id] as const,
  lines: (id: string) => [...purchasingKeys.orders(), 'lines', id] as const,
  receipts: (id: string) => [...purchasingKeys.orders(), 'receipts', id] as const,
  productSuppliers: (params?: ListProductSuppliersQuery) =>
    [...purchasingKeys.all, 'product-suppliers', params ?? {}] as const,
};

/** Everything a receive can change: the order, stock, the ledger, replenishment's incoming and plans. */
function invalidateAfterReceive(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: purchasingKeys.orders() });
  void qc.invalidateQueries({ queryKey: ['weldstash', 'stock'] });
  void qc.invalidateQueries({ queryKey: ['weldstash', 'movements'] });
  void qc.invalidateQueries({ queryKey: ['weldstash', 'replenishment'] });
}

// ---------------------- Receiving support: locations and lot tracking ----------------------

export interface WarehouseLocationOption {
  id: string;
  code: string;
  name: string | null;
}

/** Locations of a warehouse, for the receive dialog's location choice. */
export function useWarehouseLocations(warehouseId: string | null | undefined, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...purchasingKeys.all, 'locations', warehouseId ?? ''],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<ListResponse<WarehouseLocationOption>>(
        `/warehouse-locations?warehouseId=${encodeURIComponent(warehouseId as string)}&limit=200`,
      );
      return res.data;
    },
    enabled: !!warehouseId && enabled,
  });
}

export interface ProductTracking {
  id: string;
  trackLots: boolean;
  trackExpiry: boolean;
}

/**
 * Whether each product tracks lots or expiry dates, for the receive dialog
 * (a lot-tracked product needs a lot number). One `GET /products/:id` per
 * product, cached; the result is keyed by product id.
 */
export function useProductTracking(productIds: readonly string[], enabled = true) {
  const { getClient } = useAppApiClient();
  const unique = [...new Set(productIds)];
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: ['weldstash', 'products', 'tracking', id],
      queryFn: async (): Promise<ProductTracking> => {
        const client = await getClient();
        const res = await client.get<DataResponse<{ id: string; trackLots?: boolean | null; trackExpiry?: boolean | null }>>(
          `/products/${id}`,
        );
        return { id, trackLots: !!res.data.trackLots, trackExpiry: !!res.data.trackExpiry };
      },
      enabled,
      staleTime: 60_000,
    })),
  });
  const tracking: Record<string, ProductTracking> = {};
  for (const result of results) if (result.data) tracking[result.data.id] = result.data;
  return { tracking, isLoading: results.some((r) => r.isLoading) };
}

// ---------------------- Purchase orders ----------------------

/** Cursor-paged purchase orders for the list screen. */
export function useInfinitePurchaseOrders(params: Omit<ListPurchaseOrdersQuery, 'cursor'> = { limit: 50 }) {
  const api = useAppApi();
  return useInfiniteQuery({
    queryKey: [...purchasingKeys.orders(), 'infinite', params],
    queryFn: ({ pageParam }) => api.purchaseOrders.list({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? (lastPage.pagination.cursor ?? undefined) : undefined,
  });
}

export function usePurchaseOrder(id: string) {
  const api = useAppApi();
  return useQuery({
    queryKey: purchasingKeys.order(id),
    queryFn: async () => (await api.purchaseOrders.get(id)).data,
    enabled: !!id,
  });
}

export function usePurchaseOrderLines(id: string) {
  const api = useAppApi();
  return useQuery({
    queryKey: purchasingKeys.lines(id),
    queryFn: async () => (await api.purchaseOrders.listLines(id)).data,
    enabled: !!id,
  });
}

/** Receipts of an order (Kubernetes editions only). */
export function usePurchaseOrderReceipts(id: string) {
  const api = useAppApi();
  return useQuery({
    queryKey: purchasingKeys.receipts(id),
    queryFn: async () => (await api.purchaseOrders.listReceipts(id)).data,
    enabled: !!id && isFeatureAvailable('stash-replenishment'),
  });
}

export function useCreatePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePurchaseOrderInput) => (await api.purchaseOrders.create(data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useUpdatePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdatePurchaseOrderInput }) =>
      (await api.purchaseOrders.update(id, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useDeletePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.purchaseOrders.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

// ---------------------- Lines ----------------------

export function useCreatePurchaseOrderLine(orderId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePurchaseOrderLineInput) => (await api.purchaseOrders.createLine(orderId, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useUpdatePurchaseOrderLine(orderId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, data }: { itemId: string; data: UpdatePurchaseOrderLineInput }) =>
      (await api.purchaseOrders.updateLine(orderId, itemId, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useDeletePurchaseOrderLine(orderId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.purchaseOrders.deleteLine(orderId, itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

// ---------------------- Status actions (Rust backend) ----------------------

export function useApprovePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.purchaseOrders.approve(id)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useMarkPurchaseOrderOrdered() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: MarkPurchaseOrderOrderedInput }) =>
      (await api.purchaseOrders.markOrdered(id, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

export function useCancelPurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.purchaseOrders.cancel(id)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: purchasingKeys.orders() });
      void qc.invalidateQueries({ queryKey: ['weldstash', 'replenishment'] });
    },
  });
}

export function useClosePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.purchaseOrders.close(id)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

/** Receives goods. The caller supplies the idempotency key, one per submit, kept across retries of that submit. */
export function useReceivePurchaseOrder() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: ReceivePurchaseOrderInput }) =>
      (await api.purchaseOrders.receive(id, data)).data,
    onSuccess: () => invalidateAfterReceive(qc),
  });
}

export function useSendPurchaseOrderToOdoo() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.purchaseOrders.sendToOdoo(id)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: purchasingKeys.orders() }),
  });
}

// ---------------------- Product suppliers (Rust backend) ----------------------

export function useProductSuppliers(params: ListProductSuppliersQuery, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: purchasingKeys.productSuppliers(params),
    queryFn: async () => (await api.productSuppliers.list(params)).data,
    enabled: enabled && isFeatureAvailable('stash-replenishment'),
  });
}

function useProductSupplierInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...purchasingKeys.all, 'product-suppliers'] });
    // The planner reads the preferred supplier, so its plans change with it.
    void qc.invalidateQueries({ queryKey: ['weldstash', 'replenishment'] });
  };
}

export function useCreateProductSupplier() {
  const api = useAppApi();
  const invalidate = useProductSupplierInvalidation();
  return useMutation({
    mutationFn: async (data: CreateProductSupplierInput) => (await api.productSuppliers.create(data)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateProductSupplier() {
  const api = useAppApi();
  const invalidate = useProductSupplierInvalidation();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateProductSupplierInput }) =>
      (await api.productSuppliers.update(id, data)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteProductSupplier() {
  const api = useAppApi();
  const invalidate = useProductSupplierInvalidation();
  return useMutation({
    mutationFn: (id: string) => api.productSuppliers.delete(id),
    onSuccess: invalidate,
  });
}

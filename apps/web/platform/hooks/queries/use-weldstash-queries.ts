/**
 * WeldStash Query Hooks
 *
 * All endpoints live on app-api:
 * - Products:   /products (WMS + WeldCommerce shared `products` table)
 * - Suppliers:  /wms-suppliers
 * - Warehouses: /warehouses (PATCH for updates)
 * - Stock:      /inventory, /inventory/adjust, /inventory-movements
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  WeldstashListQuery,
  ListStockQuery,
  CreateProductInput,
  CreateWarehouseInput,
  UpdateWarehouseInput,
  AdjustStockInput,
  WeldstashProduct,
  WeldstashWarehouse,
  WeldstashStockRow,
  WeldstashStockMovement,
} from '@weldsuite/core-api-client/schemas/weldstash';
import type {
  CreateWmsSupplierInput,
  UpdateWmsSupplierInput,
} from '@weldsuite/app-api-client/schemas/wms-suppliers';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';

// ============================================================================
// Supplier response type matching what app-api /wms-suppliers returns.
// ============================================================================

export interface WmsSupplier {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  paymentTerms?: string | null;
  currency?: string | null;
  taxId?: string | null;
  defaultLeadTimeDays?: number | null;
  isActive: boolean;
  status: string;
  rating?: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

const weldstashKeys = {
  all: ['weldstash'] as const,
  products: () => [...weldstashKeys.all, 'products'] as const,
  productList: (params?: WeldstashListQuery) => [...weldstashKeys.products(), 'list', params ?? {}] as const,
  product: (id: string) => [...weldstashKeys.products(), 'detail', id] as const,
  suppliers: () => [...weldstashKeys.all, 'suppliers'] as const,
  supplierList: (params?: WeldstashListQuery) => [...weldstashKeys.suppliers(), 'list', params ?? {}] as const,
  supplier: (id: string) => [...weldstashKeys.suppliers(), 'detail', id] as const,
  warehouses: () => [...weldstashKeys.all, 'warehouses'] as const,
  warehouseList: (params?: WeldstashListQuery) => [...weldstashKeys.warehouses(), 'list', params ?? {}] as const,
  warehouse: (id: string) => [...weldstashKeys.warehouses(), 'detail', id] as const,
  stock: () => [...weldstashKeys.all, 'stock'] as const,
  stockList: (params?: ListStockQuery) => [...weldstashKeys.stock(), 'list', params ?? {}] as const,
  movements: (params?: Record<string, unknown>) => [...weldstashKeys.all, 'movements', params ?? {}] as const,
  pickLists: () => [...weldstashKeys.all, 'pickLists'] as const,
  pickListList: (params?: Record<string, unknown>) => [...weldstashKeys.pickLists(), 'list', params ?? {}] as const,
  pickList: (id: string) => [...weldstashKeys.pickLists(), 'detail', id] as const,
};

// ---------------------- Products ----------------------

/** Matches core-api's slug generation for WMS-created products. */
function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function useWeldstashProducts(params?: WeldstashListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.productList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 25 }) as Record<string, unknown>);
      return client.get<ListResponse<WeldstashProduct>>(`/products${qs}`);
    },
  });
}
/**
 * Cursor-paged variants used by the EntityGrid screens. The plain `use*`
 * queries above are kept for the pickers and the overview counters, which
 * only ever want one page.
 */
export function useInfiniteWeldstashProducts(params?: Omit<WeldstashListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...weldstashKeys.products(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<WeldstashProduct>>(`/products${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useInfiniteWeldstashSuppliers(params?: Omit<WeldstashListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...weldstashKeys.suppliers(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<WmsSupplier>>(`/wms-suppliers${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useInfiniteWeldstashWarehouses(params?: Omit<WeldstashListQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...weldstashKeys.warehouses(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<WeldstashWarehouse>>(`/warehouses${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useInfiniteWeldstashStock(params?: Omit<ListStockQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...weldstashKeys.stock(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<WeldstashStockRow>>(`/inventory${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useCreateWeldstashProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateProductInput) => {
      const client = await getClient();
      // app-api /products requires a slug; core-api generated it server-side.
      const slug = `${slugify(data.name)}-${Math.random().toString(36).slice(2, 8)}`;
      return client.post<DataResponse<{ id: string }>>('/products', {
        ...data,
        slug,
        sku: data.sku?.toUpperCase(),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.products() }),
  });
}

export function useUpdateWeldstashProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: unknown }) => {
      const client = await getClient();
      return client.patch<DataResponse<{ id: string }>>(`/products/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.products() });
      qc.invalidateQueries({ queryKey: weldstashKeys.product(vars.id) });
    },
  });
}

export function useDeleteWeldstashProduct() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/products/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.products() }),
  });
}

// ---------------------- Suppliers (via app-api /wms-suppliers) ----------------------
// NOTE: core-api never had a /weldstash/suppliers route.
// The app-api /wms-suppliers endpoint (backed by the `suppliers` table) is the
// authoritative backend for this resource.

export function useWeldstashSuppliers(params?: WeldstashListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.supplierList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 25 }) as Record<string, unknown>);
      return client.get<ListResponse<WmsSupplier>>(`/wms-suppliers${qs}`);
    },
  });
}
export function useWeldstashSupplier(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.supplier(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WmsSupplier>>(`/wms-suppliers/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateWeldstashSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateWmsSupplierInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>('/wms-suppliers', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.suppliers() }),
  });
}

export function useUpdateWeldstashSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateWmsSupplierInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<{ id: string }>>(`/wms-suppliers/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.suppliers() });
      qc.invalidateQueries({ queryKey: weldstashKeys.supplier(vars.id) });
    },
  });
}

export function useDeleteWeldstashSupplier() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/wms-suppliers/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.suppliers() }),
  });
}

// ---------------------- Warehouses ----------------------

export function useWeldstashWarehouses(params?: WeldstashListQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.warehouseList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 25 }) as Record<string, unknown>);
      return client.get<ListResponse<WeldstashWarehouse>>(`/warehouses${qs}`);
    },
  });
}
export function useWeldstashWarehouse(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.warehouse(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WeldstashWarehouse>>(`/warehouses/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateWeldstashWarehouse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateWarehouseInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>('/warehouses', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.warehouses() }),
  });
}

export function useUpdateWeldstashWarehouse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    // app-api uses PATCH (core-api used PUT).
    mutationFn: async ({ id, data }: { id: string; data: UpdateWarehouseInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<{ id: string }>>(`/warehouses/${id}`, data);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.warehouses() });
      qc.invalidateQueries({ queryKey: weldstashKeys.warehouse(vars.id) });
    },
  });
}

export function useDeleteWeldstashWarehouse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/warehouses/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.warehouses() }),
  });
}

// ---------------------- Stock ----------------------

export function useWeldstashStock(params?: ListStockQuery) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.stockList(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 50 }) as Record<string, unknown>);
      return client.get<ListResponse<WeldstashStockRow>>(`/inventory${qs}`);
    },
  });
}

/**
 * Movement history for a product (or warehouse). Backs the Movements tab of
 * the product object panel — the audit trail `/inventory/adjust` writes
 * alongside every level change.
 */
export function useWeldstashMovements(
  params?: { productId?: string; warehouseId?: string; limit?: number },
  enabled = true,
) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.movements(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? { limit: 25 }) as Record<string, unknown>);
      return client.get<ListResponse<WeldstashStockMovement>>(`/inventory-movements${qs}`);
    },
    enabled,
  });
}

export function useAdjustWeldstashStock() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: AdjustStockInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ inventoryId: string; movementId: string; quantityOnHand: number }>>(
        '/inventory/adjust',
        data,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldstashKeys.stock() });
      qc.invalidateQueries({ queryKey: [...weldstashKeys.all, 'movements'] });
    },
  });
}

export interface WeldstashPickList {
  id: string;
  pickListNumber: string;
  warehouseId: string;
  status: string;
  assignedTo?: string | null;
  assignedToName?: string | null;
  totalItems?: number | null;
  pickedItems?: number | null;
  totalQuantity?: number | null;
  pickedQuantity?: number | null;
  orderIds?: string[] | null;
  packedAt?: string | null;
  shippedAt?: string | null;
  shipmentId?: string | null;
  parcelId?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: Array<{
    id: string;
    name: string;
    sku?: string | null;
    locationCode?: string | null;
    quantityRequired: number;
    quantityPicked?: number | null;
    status?: string | null;
  }>;
}

export interface ListPickListsQuery {
  limit?: number;
  status?: string;
  warehouseId?: string;
  assignedTo?: string;
}

export function useInfiniteWeldstashPickLists(params?: Omit<ListPickListsQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...weldstashKeys.pickLists(), 'infinite', params ?? {}],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({
        ...(params ?? { limit: 50 }),
        cursor: pageParam as string | undefined,
      } as Record<string, unknown>);
      return client.get<ListResponse<WeldstashPickList>>(`/pick-lists${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function useWeldstashPickList(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.pickList(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WeldstashPickList>>(`/pick-lists/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useGenerateWeldstashPickList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { orderId: string; warehouseId?: string; assignedTo?: string; assignedToName?: string }) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string; pickListNumber: string }>>('/pick-lists/generate', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: weldstashKeys.pickLists() }),
  });
}

export function useAssignWeldstashPickList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, assignedTo, assignedToName }: { id: string; assignedTo: string | null; assignedToName?: string | null }) => {
      const client = await getClient();
      return client.patch<DataResponse<{ id: string; status: string }>>(`/pick-lists/${id}/assign`, {
        assignedTo,
        assignedToName,
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.pickLists() });
      qc.invalidateQueries({ queryKey: weldstashKeys.pickList(vars.id) });
    },
  });
}

export function usePackWeldstashPickList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string; status: string }>>(`/pick-lists/${id}/pack`, {});
    },
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.pickLists() });
      qc.invalidateQueries({ queryKey: weldstashKeys.pickList(id) });
    },
  });
}

export function useShipWeldstashPickList() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string; status: string }>>(`/pick-lists/${id}/ship`, {});
    },
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: weldstashKeys.pickLists() });
      qc.invalidateQueries({ queryKey: weldstashKeys.pickList(id) });
    },
  });
}

export function usePrintPackingSlip() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      const res = await client.getRaw(`/pick-lists/${id}/packing-slip`);
      const html = await res.text();
      const popup = window.open('', '_blank');
      if (popup) {
        popup.document.write(html);
        popup.document.close();
      }
    },
  });
}
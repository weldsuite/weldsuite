/**
 * WeldStash Query Hooks
 *
 * All endpoints live on app-api:
 * - Products:   /products (WMS + WeldCommerce shared `products` table)
 * - Suppliers:  /wms-suppliers
 * - Warehouses: /warehouses (PATCH for updates)
 * - Stock:      /inventory, /inventory/adjust, /inventory-movements
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

function useWeldstashProduct(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.product(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WeldstashProduct>>(`/products/${id}`);
    },
    enabled: !!id,
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

function useWeldstashSupplier(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.supplier(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WmsSupplier>>(`/wms-suppliers/${id}`);
    },
    enabled: !!id,
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

function useWeldstashWarehouse(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.warehouse(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<WeldstashWarehouse>>(`/warehouses/${id}`);
    },
    enabled: !!id,
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

function useWeldstashMovements(params?: { productId?: string; warehouseId?: string; limit?: number; cursor?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldstashKeys.movements(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString((params ?? {}) as Record<string, unknown>);
      return client.get<ListResponse<WeldstashStockMovement>>(`/inventory-movements${qs}`);
    },
  });
}

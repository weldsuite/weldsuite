import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  WeldstashProduct,
  WeldstashSupplier,
  WeldstashWarehouse,
  WeldstashStockRow,
  WeldstashStockMovement,
  CreateProductInput,
  UpdateProductInput,
  CreateSupplierInput,
  UpdateSupplierInput,
  CreateWarehouseInput,
  UpdateWarehouseInput,
  AdjustStockInput,
  WeldstashListQuery,
  ListStockQuery,
} from '../schemas/weldstash';

export function createWeldstashApi(api: ClientApi) {
  return {
    // ---------- Products ----------
    listProducts(params: WeldstashListQuery = { limit: 25 }): Promise<ListResponse<WeldstashProduct>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WeldstashProduct>>(`/weldstash/products${query}`);
    },
    getProduct(id: string): Promise<DataResponse<WeldstashProduct>> {
      return api.get<DataResponse<WeldstashProduct>>(`/weldstash/products/${id}`);
    },
    createProduct(data: CreateProductInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldstash/products', data);
    },
    updateProduct(id: string, data: UpdateProductInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldstash/products/${id}`, data);
    },
    deleteProduct(id: string): Promise<void> {
      return api.delete<void>(`/weldstash/products/${id}`);
    },

    // ---------- Suppliers ----------
    listSuppliers(params: WeldstashListQuery = { limit: 25 }): Promise<ListResponse<WeldstashSupplier>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WeldstashSupplier>>(`/weldstash/suppliers${query}`);
    },
    getSupplier(id: string): Promise<DataResponse<WeldstashSupplier>> {
      return api.get<DataResponse<WeldstashSupplier>>(`/weldstash/suppliers/${id}`);
    },
    createSupplier(data: CreateSupplierInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldstash/suppliers', data);
    },
    updateSupplier(id: string, data: UpdateSupplierInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldstash/suppliers/${id}`, data);
    },
    deleteSupplier(id: string): Promise<void> {
      return api.delete<void>(`/weldstash/suppliers/${id}`);
    },

    // ---------- Warehouses ----------
    listWarehouses(params: WeldstashListQuery = { limit: 25 }): Promise<ListResponse<WeldstashWarehouse>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WeldstashWarehouse>>(`/weldstash/warehouses${query}`);
    },
    getWarehouse(id: string): Promise<DataResponse<WeldstashWarehouse>> {
      return api.get<DataResponse<WeldstashWarehouse>>(`/weldstash/warehouses/${id}`);
    },
    createWarehouse(data: CreateWarehouseInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/weldstash/warehouses', data);
    },
    updateWarehouse(id: string, data: UpdateWarehouseInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldstash/warehouses/${id}`, data);
    },
    deleteWarehouse(id: string): Promise<void> {
      return api.delete<void>(`/weldstash/warehouses/${id}`);
    },

    // ---------- Stock / Inventory ----------
    listStock(params: ListStockQuery = { limit: 50 }): Promise<ListResponse<WeldstashStockRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WeldstashStockRow>>(`/weldstash/inventory${query}`);
    },
    adjustStock(data: AdjustStockInput): Promise<DataResponse<{ inventoryId: string; movementId: string; quantityOnHand: number }>> {
      return api.post<DataResponse<{ inventoryId: string; movementId: string; quantityOnHand: number }>>(
        '/weldstash/inventory/adjust',
        data,
      );
    },
    listStockMovements(params: { productId?: string; warehouseId?: string; limit?: number; cursor?: string } = {}): Promise<ListResponse<WeldstashStockMovement>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WeldstashStockMovement>>(`/weldstash/inventory/movements${query}`);
    },
  };
}

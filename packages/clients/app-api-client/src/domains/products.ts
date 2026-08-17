/**
 * App-API products domain client — flat /api/products/* surface.
 *
 * Shared by WeldCommerce and WeldStash / WeldWMS. Stock quantity on a product
 * is a roll-up; warehouse-level stock lives on `/inventory`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  price?: string | number | null;
  costPrice?: string | number | null;
  currency?: string | null;
  trackInventory?: boolean | null;
  inventoryQuantity?: number | null;
  lowStockThreshold?: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListProductsQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  status?: string;
}

export interface CreateProductInput {
  name: string;
  slug: string;
  sku?: string;
  barcode?: string;
  description?: string;
  price?: number | string;
  costPrice?: number | string;
  currency?: string;
  status?: string;
  trackInventory?: boolean;
  lowStockThreshold?: number;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'slug'>> & {
  slug?: string;
};

export function createProductsApi(api: ClientApi) {
  return {
    list(params: ListProductsQuery = {}): Promise<ListResponse<ProductRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProductRow>>(`/products${query}`);
    },

    get(id: string): Promise<DataResponse<ProductRow>> {
      return api.get<DataResponse<ProductRow>>(`/products/${id}`);
    },

    create(data: CreateProductInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/products', data);
    },

    update(id: string, data: UpdateProductInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/products/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/products/${id}`);
    },
  };
}

/**
 * App-API product suppliers domain client: `/api/product-suppliers/*`.
 * Which supplier a product is bought from, and on what terms. Served by the
 * Rust backend only (the Kubernetes editions); Global answers 404.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateProductSupplierInput,
  ProductSupplier,
  UpdateProductSupplierInput,
} from '../schemas/product-suppliers';

export interface ListProductSuppliersQuery {
  productId?: string;
  /** `none` lists the rows without a variant. */
  variantId?: string;
  supplierId?: string;
}

export function createProductSuppliersApi(api: ClientApi) {
  return {
    list(params: ListProductSuppliersQuery = {}): Promise<ListResponse<ProductSupplier>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProductSupplier>>(`/product-suppliers${query}`);
    },

    create(data: CreateProductSupplierInput): Promise<DataResponse<ProductSupplier>> {
      return api.post<DataResponse<ProductSupplier>>('/product-suppliers', data);
    },

    update(id: string, data: UpdateProductSupplierInput): Promise<DataResponse<ProductSupplier>> {
      return api.patch<DataResponse<ProductSupplier>>(`/product-suppliers/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/product-suppliers/${id}`);
    },
  };
}

/**
 * App-API warehouses domain client — flat /api/warehouses/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface WarehouseRow {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  contactName?: string | null;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListWarehousesQuery {
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface CreateWarehouseInput {
  name: string;
  code?: string;
  isDefault?: boolean;
  isActive?: boolean;
}

export function createWarehousesApi(api: ClientApi) {
  return {
    list(params: ListWarehousesQuery = {}): Promise<ListResponse<WarehouseRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WarehouseRow>>(`/warehouses${query}`);
    },

    get(id: string): Promise<DataResponse<WarehouseRow>> {
      return api.get<DataResponse<WarehouseRow>>(`/warehouses/${id}`);
    },

    create(data: CreateWarehouseInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/warehouses', data);
    },
  };
}

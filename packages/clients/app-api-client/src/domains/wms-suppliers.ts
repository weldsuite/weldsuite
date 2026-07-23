/**
 * App-API WMS suppliers domain client — /api/wms-suppliers/* surface.
 * Suppliers are vendors for purchasing inventory (WeldStash / WMS module).
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateWmsSupplierInput,
  UpdateWmsSupplierInput,
} from '../schemas/wms-suppliers';

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
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  paymentTerms?: string | null;
  currency?: string | null;
  taxId?: string | null;
  defaultLeadTimeDays?: number | null;
  isActive?: boolean | null;
  status?: string | null;
  rating?: number | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListWmsSuppliersQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  status?: string;
  isActive?: boolean;
}

export function createWmsSuppliersApi(api: ClientApi) {
  return {
    list(params: ListWmsSuppliersQuery = {}): Promise<ListResponse<WmsSupplier>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<WmsSupplier>>(`/wms-suppliers${query}`);
    },

    get(id: string): Promise<DataResponse<WmsSupplier>> {
      return api.get<DataResponse<WmsSupplier>>(`/wms-suppliers/${id}`);
    },

    create(data: CreateWmsSupplierInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/wms-suppliers', data);
    },

    update(id: string, data: UpdateWmsSupplierInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/wms-suppliers/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/wms-suppliers/${id}`);
    },
  };
}

/**
 * App-API inventory domain client — flat /api/inventory/* surface.
 *
 * Quantity writes go through `/adjust` (the ledger). Listing returns the
 * warehouse / location / lot buckets plus product and warehouse names.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { AdjustInventoryInput } from '../schemas/inventory-ledger';

export interface InventoryRow {
  id: string;
  productId: string;
  warehouseId: string;
  locationId?: string | null;
  variantId?: string | null;
  quantityOnHand: number;
  quantityAllocated?: number | null;
  quantityAvailable?: number | null;
  quantityIncoming?: number | null;
  lotNumber?: string | null;
  status?: string | null;
  productName?: string | null;
  productSku?: string | null;
  warehouseName?: string | null;
  locationCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListInventoryQuery {
  limit?: number;
  cursor?: string;
  productId?: string;
  warehouseId?: string;
  lowStockOnly?: boolean;
}

export interface AdjustInventoryResult {
  inventoryId: string;
  adjustmentId: string;
  previousQuantity: number;
  quantityOnHand: number;
  productQuantity: number;
}

export function createInventoryApi(api: ClientApi) {
  return {
    list(params: ListInventoryQuery = {}): Promise<ListResponse<InventoryRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<InventoryRow>>(`/inventory${query}`);
    },

    get(id: string): Promise<DataResponse<InventoryRow>> {
      return api.get<DataResponse<InventoryRow>>(`/inventory/${id}`);
    },

    adjust(data: AdjustInventoryInput): Promise<DataResponse<AdjustInventoryResult>> {
      return api.post<DataResponse<AdjustInventoryResult>>('/inventory/adjust', data);
    },
  };
}

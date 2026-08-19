/**
 * App-API pick lists domain — generate / pick / pack / ship.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface PickListItemRow {
  id: string;
  pickListId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  productId: string;
  variantId?: string | null;
  sku?: string | null;
  name: string;
  locationId?: string | null;
  locationCode?: string | null;
  inventoryId?: string | null;
  quantityRequired: number;
  quantityPicked?: number | null;
  quantityShort?: number | null;
  lotNumber?: string | null;
  status?: string | null;
  pickSequence?: number | null;
  pickedAt?: string | null;
}

export interface PickListRow {
  id: string;
  pickListNumber: string;
  warehouseId: string;
  status: string;
  priority?: string | null;
  assignedTo?: string | null;
  assignedToName?: string | null;
  totalItems?: number | null;
  pickedItems?: number | null;
  totalQuantity?: number | null;
  pickedQuantity?: number | null;
  orderIds?: string[] | null;
  orderCount?: number | null;
  pickType?: string | null;
  packedAt?: string | null;
  shippedAt?: string | null;
  shipmentId?: string | null;
  parcelId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: PickListItemRow[];
}

export interface ListPickListsQuery {
  limit?: number;
  cursor?: string;
  warehouseId?: string;
  status?: string;
  assignedTo?: string;
}

export interface GeneratePickListInput {
  orderId: string;
  warehouseId?: string;
  assignedTo?: string;
  assignedToName?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface ConfirmPickInput {
  quantity: number;
  productBarcode: string;
  locationBarcode?: string;
  short?: boolean;
}

export function createPickListsApi(api: ClientApi) {
  return {
    list(params: ListPickListsQuery = {}): Promise<ListResponse<PickListRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<PickListRow>>(`/pick-lists${query}`);
    },

    get(id: string): Promise<DataResponse<PickListRow>> {
      return api.get<DataResponse<PickListRow>>(`/pick-lists/${id}`);
    },

    generate(data: GeneratePickListInput): Promise<DataResponse<{ id: string; pickListNumber: string; status: string; itemCount: number }>> {
      return api.post(`/pick-lists/generate`, data);
    },

    assign(id: string, data: { assignedTo?: string | null; assignedToName?: string | null }): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch(`/pick-lists/${id}/assign`, data);
    },

    start(id: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch(`/pick-lists/${id}/start`, {});
    },

    pickItem(id: string, itemId: string, data: ConfirmPickInput): Promise<DataResponse<{ id: string; status: string; quantityPicked: number; quantityShort: number }>> {
      return api.post(`/pick-lists/${id}/items/${itemId}/pick`, data);
    },

    complete(id: string): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch(`/pick-lists/${id}/complete`, {});
    },

    pack(id: string): Promise<DataResponse<{ id: string; status: string; parcelId?: string }>> {
      return api.post(`/pick-lists/${id}/pack`, {});
    },

    packingSlipUrl(id: string): string {
      return `/pick-lists/${id}/packing-slip`;
    },

    ship(id: string): Promise<DataResponse<{ id: string; status: string; shipmentId?: string; parcelId?: string }>> {
      return api.post(`/pick-lists/${id}/ship`, {});
    },
  };
}

/**
 * App-API purchase orders domain client: `/api/purchase-orders/*`.
 *
 * The header and line CRUD is served on every edition (create returns only
 * `{ id }` there). The status actions, receiving, receipts and Send to Odoo
 * exist on the Rust backend only (the Kubernetes editions).
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreatePurchaseOrderInput,
  CreatePurchaseOrderLineInput,
  MarkPurchaseOrderOrderedInput,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderReceipt,
  ReceivePurchaseOrderInput,
  ReceivePurchaseOrderResult,
  SendToOdooResult,
  UpdatePurchaseOrderInput,
  UpdatePurchaseOrderLineInput,
} from '../schemas/purchase-orders';

export interface ListPurchaseOrdersQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  status?: string;
  supplierId?: string;
  warehouseId?: string;
}

export function createPurchaseOrdersApi(api: ClientApi) {
  const base = '/purchase-orders';
  return {
    list(params: ListPurchaseOrdersQuery = {}): Promise<ListResponse<PurchaseOrder>> {
      return api.get<ListResponse<PurchaseOrder>>(`${base}${buildQueryString(params as Record<string, unknown>)}`);
    },
    get(id: string): Promise<DataResponse<PurchaseOrder>> {
      return api.get<DataResponse<PurchaseOrder>>(`${base}/${id}`);
    },
    create(data: CreatePurchaseOrderInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(base, data);
    },
    update(id: string, data: UpdatePurchaseOrderInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`${base}/${id}`, data);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`${base}/${id}`);
    },

    // Lines (draft purchase orders).
    listLines(id: string): Promise<ListResponse<PurchaseOrderLine>> {
      return api.get<ListResponse<PurchaseOrderLine>>(`${base}/${id}/items`);
    },
    createLine(id: string, data: CreatePurchaseOrderLineInput): Promise<DataResponse<PurchaseOrderLine>> {
      return api.post<DataResponse<PurchaseOrderLine>>(`${base}/${id}/items`, data);
    },
    updateLine(id: string, itemId: string, data: UpdatePurchaseOrderLineInput): Promise<DataResponse<PurchaseOrderLine>> {
      return api.patch<DataResponse<PurchaseOrderLine>>(`${base}/${id}/items/${itemId}`, data);
    },
    deleteLine(id: string, itemId: string): Promise<void> {
      return api.delete<void>(`${base}/${id}/items/${itemId}`);
    },

    // Rust backend only.
    approve(id: string): Promise<DataResponse<PurchaseOrder>> {
      return api.post<DataResponse<PurchaseOrder>>(`${base}/${id}/approve`, {});
    },
    markOrdered(id: string, data: MarkPurchaseOrderOrderedInput = {}): Promise<DataResponse<PurchaseOrder>> {
      return api.post<DataResponse<PurchaseOrder>>(`${base}/${id}/mark-ordered`, data);
    },
    receive(id: string, data: ReceivePurchaseOrderInput): Promise<DataResponse<ReceivePurchaseOrderResult>> {
      return api.post<DataResponse<ReceivePurchaseOrderResult>>(`${base}/${id}/receive`, data);
    },
    cancel(id: string): Promise<DataResponse<PurchaseOrder>> {
      return api.post<DataResponse<PurchaseOrder>>(`${base}/${id}/cancel`, {});
    },
    close(id: string): Promise<DataResponse<PurchaseOrder>> {
      return api.post<DataResponse<PurchaseOrder>>(`${base}/${id}/close`, {});
    },
    listReceipts(id: string): Promise<ListResponse<PurchaseOrderReceipt>> {
      return api.get<ListResponse<PurchaseOrderReceipt>>(`${base}/${id}/receipts`);
    },
    sendToOdoo(id: string): Promise<DataResponse<SendToOdooResult>> {
      return api.post<DataResponse<SendToOdooResult>>(`${base}/${id}/send-to-odoo`, {});
    },
  };
}

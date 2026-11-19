import { z } from 'zod';

// ============================================================================
// Purchase orders (WeldStash purchasing): the header and line CRUD every
// edition serves, and the receive / send-to-Odoo actions the Rust backend
// (Kubernetes editions) adds. `/api/purchase-orders`. Permissions: `orders:*`.
//
// Numeric columns arrive as strings (Drizzle style); requests carry numbers.
// ============================================================================

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'ordered',
  'partial',
  'received',
  'cancelled',
  'closed',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const createPurchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(50).optional(),
  supplierId: z.string().nullish(),
  supplierName: z.string().max(255).nullish(),
  warehouseId: z.string().nullish(),
  warehouseName: z.string().max(255).nullish(),
  orderDate: z.string().nullish(),
  expectedDate: z.string().nullish(),
  currency: z.string().length(3).optional(),
  shippingTotal: z.number().min(0).optional(),
  discountTotal: z.number().min(0).optional(),
  paymentTerms: z.string().max(100).nullish(),
  supplierNotes: z.string().nullish(),
  internalNotes: z.string().nullish(),
});

/**
 * Every header field optional. `status` is for Global, where nothing else moves a
 * status; on the Kubernetes editions the action routes (approve, receive, ...) do.
 */
export const updatePurchaseOrderSchema = createPurchaseOrderSchema.partial().extend({ status: z.string().max(30).optional() });

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

export const createPurchaseOrderLineSchema = z.object({
  productId: z.string().nullish(),
  variantId: z.string().nullish(),
  sku: z.string().max(100).nullish(),
  name: z.string().min(1).max(255),
  quantityOrdered: z.number().int().min(1).max(1_000_000).optional(),
  unitPrice: z.number().min(0).max(10_000_000),
  discountPercent: z.number().min(0).max(100).optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  notes: z.string().nullish(),
});

export const updatePurchaseOrderLineSchema = createPurchaseOrderLineSchema.partial();

export type CreatePurchaseOrderLineInput = z.infer<typeof createPurchaseOrderLineSchema>;
export type UpdatePurchaseOrderLineInput = z.infer<typeof updatePurchaseOrderLineSchema>;

/** `POST /purchase-orders/{id}/mark-ordered`. */
export const markPurchaseOrderOrderedSchema = z.object({
  orderDate: z.string().optional(),
  expectedDate: z.string().optional(),
});
export type MarkPurchaseOrderOrderedInput = z.infer<typeof markPurchaseOrderOrderedSchema>;

export const receivePurchaseOrderLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(0),
  rejected: z.number().int().min(0).optional(),
  locationId: z.string().nullish(),
  lotNumber: z.string().nullish(),
  expiryDate: z.string().nullish(),
});

/** `POST /purchase-orders/{id}/receive`. The key makes a retried submit post nothing twice. */
export const receivePurchaseOrderSchema = z.object({
  idempotencyKey: z.string().min(1).max(100),
  lines: z.array(receivePurchaseOrderLineSchema).min(1),
  notes: z.string().optional(),
});
export type ReceivePurchaseOrderLineInput = z.infer<typeof receivePurchaseOrderLineSchema>;
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>;

/** A purchase order header as the API returns it. */
export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  status: string;
  orderDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  currency: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  shippingTotal: string | null;
  discountTotal: string | null;
  total: string | null;
  itemCount: number | null;
  totalQuantityOrdered: number | null;
  totalQuantityReceived: number | null;
  paymentTerms: string | null;
  supplierNotes: string | null;
  internalNotes: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  /** `metadata.odoo` is set once the order was sent to Odoo; Odoo is then its master. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  quantityOrdered: number;
  quantityReceived: number | null;
  quantityPending: number | null;
  quantityRejected: number | null;
  unitPrice: string;
  discountPercent: string | null;
  discountAmount: string | null;
  taxPercent: string | null;
  taxAmount: string | null;
  total: string;
  lastReceivedDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderReceiptLine {
  itemId: string;
  quantity: number;
  rejected: number;
  locationId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  adjustmentIds: string[];
}

export interface PurchaseOrderReceipt {
  id: string;
  purchaseOrderId: string;
  idempotencyKey: string;
  lines: PurchaseOrderReceiptLine[];
  receivedAt: string;
  receivedBy: string | null;
  receivedByName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ReceivePurchaseOrderResult {
  receipt: PurchaseOrderReceipt;
  purchaseOrder: PurchaseOrder;
  items: PurchaseOrderLine[];
}

export interface SendToOdooResult {
  purchaseOrder: PurchaseOrder;
  odoo: { id: number; name: string };
}

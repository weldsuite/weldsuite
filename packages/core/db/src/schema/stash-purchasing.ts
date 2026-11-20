import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * WeldStash purchasing (weldsuite-documentation/plans/weldstash-replenishment.md, phase 1).
 * Served by the Rust backend only (`rust/modules/stash`); the TypeScript
 * stash-api does not read these tables.
 */

/** Line of a receipt, as `purchase_order_receipts.lines` stores it. */
export interface PurchaseOrderReceiptLine {
  itemId: string;
  quantity: number;
  rejected: number;
  locationId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  /** `stock_adjustments.id` of each ledger change the line made. */
  adjustmentIds: string[];
}

// Product suppliers - who a product (or variant) is bought from, and on what terms.
export const productSuppliers = pgTable('product_suppliers', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  supplierId: varchar('supplier_id', { length: 30 }).notNull(),

  // Printed on the purchase order
  supplierSku: varchar('supplier_sku', { length: 100 }),
  supplierProductName: varchar('supplier_product_name', { length: 255 }),

  // Terms
  unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
  currency: varchar('currency', { length: 3 }),
  /** Null: the supplier's `default_lead_time_days`. */
  leadTimeDays: integer('lead_time_days'),
  /** Minimum order quantity, in units. */
  minOrderQty: integer('min_order_qty'),
  /** Pack or case size: ordered quantities round up to a multiple of it. */
  orderMultiple: integer('order_multiple').notNull().default(1),
  /** One preferred supplier per product/variant, kept so by the service. */
  isPreferred: boolean('is_preferred').notNull().default(false),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('product_suppliers_product_idx').on(table.productId),
  index('product_suppliers_supplier_idx').on(table.supplierId),
  uniqueIndex('product_suppliers_unique')
    .on(table.productId, sql`coalesce(${table.variantId}, '')`, table.supplierId)
    .where(sql`deleted_at IS NULL`),
]);

export type ProductSupplier = typeof productSuppliers.$inferSelect;
export type NewProductSupplier = typeof productSuppliers.$inferInsert;

// Purchase order receipts - one row per receive action: the trail of what
// arrived, and the idempotency key that stops a retried request posting stock twice.
export const purchaseOrderReceipts = pgTable('purchase_order_receipts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  purchaseOrderId: varchar('purchase_order_id', { length: 30 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 100 }).notNull(),
  lines: jsonb('lines').$type<PurchaseOrderReceiptLine[]>().notNull(),

  receivedAt: timestamp('received_at').notNull().defaultNow(),
  receivedBy: varchar('received_by', { length: 255 }),
  receivedByName: varchar('received_by_name', { length: 255 }),
  notes: text('notes'),
}, (table) => [
  index('po_receipts_po_idx').on(table.purchaseOrderId),
  uniqueIndex('po_receipts_idempotency_unique').on(table.idempotencyKey),
]);

export type PurchaseOrderReceipt = typeof purchaseOrderReceipts.$inferSelect;
export type NewPurchaseOrderReceipt = typeof purchaseOrderReceipts.$inferInsert;

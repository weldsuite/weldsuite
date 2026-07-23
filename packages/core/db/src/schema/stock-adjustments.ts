import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Stock Adjustments - Complete audit trail for all stock changes
export const stockAdjustments = pgTable('stock_adjustments', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Reference - What was adjusted
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  warehouseId: varchar('warehouse_id', { length: 30 }),
  locationId: varchar('location_id', { length: 30 }),
  inventoryId: varchar('inventory_id', { length: 30 }),

  // Adjustment Type
  type: varchar('type', { length: 30 }).notNull(), // increase, decrease, correction, damage, return, transfer_in, transfer_out, received, shipped, cycle_count

  // Quantities
  previousQuantity: integer('previous_quantity').notNull(),
  adjustmentQuantity: integer('adjustment_quantity').notNull(),
  newQuantity: integer('new_quantity').notNull(),

  // Lot/Batch (for lot-tracked items)
  lotNumber: varchar('lot_number', { length: 100 }),
  batchNumber: varchar('batch_number', { length: 100 }),

  // Audit Information
  reason: text('reason'),
  reasonCode: varchar('reason_code', { length: 50 }), // Standard reason codes: DAMAGE, THEFT, FOUND, RECOUNT, RECEIVED, SHIPPED, RETURN, OTHER
  notes: text('notes'),

  // Who made the adjustment
  performedBy: varchar('performed_by', { length: 255 }),
  performedByName: varchar('performed_by_name', { length: 255 }),

  // Reference to source document
  sourceType: varchar('source_type', { length: 30 }), // order, return, purchase_order, transfer, cycle_count, manual
  sourceId: varchar('source_id', { length: 30 }),
  sourceNumber: varchar('source_number', { length: 100 }),

  // Approval (for adjustments requiring approval)
  requiresApproval: integer('requires_approval').default(0),
  approvalStatus: varchar('approval_status', { length: 30 }).default('approved'), // pending, approved, rejected
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('stock_adjustments_product_idx').on(table.productId),
  index('stock_adjustments_warehouse_idx').on(table.warehouseId),
  index('stock_adjustments_location_idx').on(table.locationId),
  index('stock_adjustments_type_idx').on(table.type),
  index('stock_adjustments_source_idx').on(table.sourceType, table.sourceId),
  index('stock_adjustments_created_idx').on(table.createdAt),
]);

export type StockAdjustment = typeof stockAdjustments.$inferSelect;
export type NewStockAdjustment = typeof stockAdjustments.$inferInsert;

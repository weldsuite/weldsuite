import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Inventory Movements - Transfers and movements between locations
export const inventoryMovements = pgTable('inventory_movements', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Identification
  movementNumber: varchar('movement_number', { length: 50 }).notNull(),

  // Movement Type
  movementType: varchar('movement_type', { length: 30 }).notNull(), // transfer, replenishment, putaway, relocation

  // Status
  status: varchar('status', { length: 30 }).notNull().default('pending'), // pending, in_progress, completed, cancelled

  // Source
  sourceWarehouseId: varchar('source_warehouse_id', { length: 30 }),
  sourceLocationId: varchar('source_location_id', { length: 30 }),
  sourceLocationCode: varchar('source_location_code', { length: 50 }),

  // Destination
  destWarehouseId: varchar('dest_warehouse_id', { length: 30 }),
  destLocationId: varchar('dest_location_id', { length: 30 }),
  destLocationCode: varchar('dest_location_code', { length: 50 }),

  // Product
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  sku: varchar('sku', { length: 100 }),
  name: varchar('name', { length: 255 }),

  // Quantity
  quantity: integer('quantity').notNull(),

  // Lot/Batch
  lotNumber: varchar('lot_number', { length: 100 }),
  batchNumber: varchar('batch_number', { length: 100 }),

  // Priority
  priority: varchar('priority', { length: 20 }).default('normal'), // low, normal, high, urgent

  // Assignment
  assignedTo: varchar('assigned_to', { length: 255 }),
  assignedToName: varchar('assigned_to_name', { length: 255 }),

  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),

  // Reference
  sourceType: varchar('source_type', { length: 30 }), // order, pick_list, replenishment_rule, manual
  sourceId: varchar('source_id', { length: 30 }),

  // Notes
  reason: text('reason'),
  notes: text('notes'),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),
  completedBy: varchar('completed_by', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('inventory_movements_number_idx').on(table.movementNumber),
  index('inventory_movements_type_idx').on(table.movementType),
  index('inventory_movements_status_idx').on(table.status),
  index('inventory_movements_source_loc_idx').on(table.sourceLocationId),
  index('inventory_movements_dest_loc_idx').on(table.destLocationId),
  index('inventory_movements_product_idx').on(table.productId),
  index('inventory_movements_created_idx').on(table.createdAt),
]);

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert;

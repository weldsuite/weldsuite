import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Cycle Counts - Inventory counting tasks
export const cycleCounts = pgTable('cycle_counts', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  countNumber: varchar('count_number', { length: 50 }).notNull(),

  // Warehouse/Zone/Location
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),
  zoneId: varchar('zone_id', { length: 30 }),
  locationIds: jsonb('location_ids').$type<string[]>(),

  // Count Type
  countType: varchar('count_type', { length: 30 }).default('full'), // full, partial, spot, abc, random

  // Status
  status: varchar('status', { length: 30 }).notNull().default('scheduled'), // scheduled, in_progress, pending_review, completed, cancelled

  // Schedule
  scheduledDate: timestamp('scheduled_date'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),

  // Assignment
  assignedTo: varchar('assigned_to', { length: 255 }),
  assignedToName: varchar('assigned_to_name', { length: 255 }),

  // Progress
  totalLocations: integer('total_locations').default(0),
  countedLocations: integer('counted_locations').default(0),
  totalProducts: integer('total_products').default(0),
  countedProducts: integer('counted_products').default(0),

  // Results
  varianceCount: integer('variance_count').default(0),
  totalVarianceQuantity: integer('total_variance_quantity').default(0),

  // Approval
  requiresApproval: integer('requires_approval').default(0),
  approvalStatus: varchar('approval_status', { length: 30 }).default('pending'), // pending, approved, rejected
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),

  // Notes
  notes: text('notes'),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('cycle_counts_number_idx').on(table.countNumber),
  index('cycle_counts_warehouse_idx').on(table.warehouseId),
  index('cycle_counts_status_idx').on(table.status),
  index('cycle_counts_scheduled_idx').on(table.scheduledDate),
]);

export type CycleCount = typeof cycleCounts.$inferSelect;
export type NewCycleCount = typeof cycleCounts.$inferInsert;

// Cycle Count Items - Individual items counted
export const cycleCountItems = pgTable('cycle_count_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  cycleCountId: varchar('cycle_count_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Location
  locationId: varchar('location_id', { length: 30 }).notNull(),
  locationCode: varchar('location_code', { length: 50 }),

  // Product
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  sku: varchar('sku', { length: 100 }),
  name: varchar('name', { length: 255 }),

  // Inventory Reference
  inventoryId: varchar('inventory_id', { length: 30 }),

  // Lot/Batch
  lotNumber: varchar('lot_number', { length: 100 }),
  batchNumber: varchar('batch_number', { length: 100 }),

  // Quantities
  expectedQuantity: integer('expected_quantity').notNull().default(0),
  countedQuantity: integer('counted_quantity'),
  variance: integer('variance'),

  // Status
  status: varchar('status', { length: 30 }).default('pending'), // pending, counted, verified, adjusted

  // Counting
  countedAt: timestamp('counted_at'),
  countedBy: varchar('counted_by', { length: 255 }),

  // Verification (for blind counts)
  verifiedQuantity: integer('verified_quantity'),
  verifiedAt: timestamp('verified_at'),
  verifiedBy: varchar('verified_by', { length: 255 }),

  // Notes
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('cycle_count_items_count_idx').on(table.cycleCountId),
  index('cycle_count_items_location_idx').on(table.locationId),
  index('cycle_count_items_product_idx').on(table.productId),
  index('cycle_count_items_status_idx').on(table.status),
]);

export type CycleCountItem = typeof cycleCountItems.$inferSelect;
export type NewCycleCountItem = typeof cycleCountItems.$inferInsert;

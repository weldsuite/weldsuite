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

// Inventory - Product inventory at specific locations
export const inventory = pgTable('inventory', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),
  locationId: varchar('location_id', { length: 30 }),
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),

  // Quantities
  quantityOnHand: integer('quantity_on_hand').notNull().default(0),
  quantityAllocated: integer('quantity_allocated').default(0), // Reserved for orders
  quantityAvailable: integer('quantity_available').default(0), // On hand - allocated
  quantityIncoming: integer('quantity_incoming').default(0), // Expected from POs
  quantityOutgoing: integer('quantity_outgoing').default(0), // Pending shipments

  // Lot/Batch Tracking
  lotNumber: varchar('lot_number', { length: 100 }),
  batchNumber: varchar('batch_number', { length: 100 }),
  serialNumber: varchar('serial_number', { length: 100 }),

  // Expiry/Dates
  expiryDate: timestamp('expiry_date'),
  manufactureDate: timestamp('manufacture_date'),
  receivedDate: timestamp('received_date'),

  // Cost
  unitCost: numeric('unit_cost', { precision: 18, scale: 2 }),
  totalValue: numeric('total_value', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('USD'),

  // Status
  status: varchar('status', { length: 30 }).default('available'), // available, quarantine, damaged, expired, reserved
  isQuarantined: boolean('is_quarantined').default(false),
  quarantineReason: text('quarantine_reason'),

  // Quality
  qualityStatus: varchar('quality_status', { length: 30 }).default('passed'), // passed, failed, pending, na
  lastInspectionDate: timestamp('last_inspection_date'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('inventory_warehouse_idx').on(table.warehouseId),
  index('inventory_location_idx').on(table.locationId),
  index('inventory_product_idx').on(table.productId),
  index('inventory_lot_idx').on(table.lotNumber),
  index('inventory_expiry_idx').on(table.expiryDate),
  index('inventory_status_idx').on(table.status),
  // One stock bucket per natural key. The ledger's "increment, and create the
  // bucket if the increment matched nothing" is a check-then-act across two
  // round-trips; without this index two simultaneous first receipts each see no
  // row and each insert, leaving one key with two buckets.
  //
  // Created with NULLS NOT DISTINCT (see the migration) — most buckets have no
  // variant, location or lot, and under the default NULLS DISTINCT those rows
  // never collide, which is precisely the case that needs protecting. Drizzle
  // 0.45's index builder cannot express the modifier, so the migration carries
  // it by hand.
  uniqueIndex('inventory_bucket_unique')
    .on(table.productId, table.warehouseId, table.variantId, table.locationId, table.lotNumber)
    .where(sql`deleted_at IS NULL`),
]);

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;

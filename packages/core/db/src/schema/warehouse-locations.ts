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
} from 'drizzle-orm/pg-core';

// Warehouse Locations - Physical storage locations within warehouse zones
export const warehouseLocations = pgTable('warehouse_locations', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Warehouse & Zone Reference
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),
  zoneId: varchar('zone_id', { length: 30 }),

  // Location Identification
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(), // e.g., A-01-02-03 (Aisle-Rack-Shelf-Bin)
  barcode: varchar('barcode', { length: 100 }),

  // Location Structure
  aisle: varchar('aisle', { length: 20 }),
  rack: varchar('rack', { length: 20 }),
  shelf: varchar('shelf', { length: 20 }),
  bin: varchar('bin', { length: 20 }),
  level: integer('level'),

  // Location Type
  locationType: varchar('location_type', { length: 50 }).default('storage'), // storage, picking, bulk, reserve, staging, dock

  // Physical Dimensions
  length: numeric('length', { precision: 10, scale: 2 }),
  width: numeric('width', { precision: 10, scale: 2 }),
  height: numeric('height', { precision: 10, scale: 2 }),
  dimensionUnit: varchar('dimension_unit', { length: 10 }).default('cm'),

  // Capacity
  maxWeight: numeric('max_weight', { precision: 10, scale: 2 }),
  weightUnit: varchar('weight_unit', { length: 10 }).default('kg'),
  maxItems: integer('max_items'),
  currentItems: integer('current_items').default(0),

  // Status
  isActive: boolean('is_active').default(true),
  isEmpty: boolean('is_empty').default(true),
  isBlocked: boolean('is_blocked').default(false),
  blockReason: text('block_reason'),

  // Picking
  pickingSequence: integer('picking_sequence').default(0),
  isPrimaryPick: boolean('is_primary_pick').default(false),

  // ABC Classification
  abcClass: varchar('abc_class', { length: 1 }), // A, B, C for velocity

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('warehouse_locations_warehouse_idx').on(table.warehouseId),
  index('warehouse_locations_zone_idx').on(table.zoneId),
  index('warehouse_locations_code_idx').on(table.code),
  index('warehouse_locations_barcode_idx').on(table.barcode),
  index('warehouse_locations_type_idx').on(table.locationType),
]);

export type WarehouseLocation = typeof warehouseLocations.$inferSelect;
export type NewWarehouseLocation = typeof warehouseLocations.$inferInsert;

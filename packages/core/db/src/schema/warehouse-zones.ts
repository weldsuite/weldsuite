import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Warehouse Zones - Logical areas within warehouses (e.g., receiving, shipping, storage)
export const warehouseZones = pgTable('warehouse_zones', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Warehouse Reference
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  description: text('description'),

  // Zone Type
  zoneType: varchar('zone_type', { length: 50 }).default('storage'), // storage, receiving, shipping, staging, quarantine, returns

  // Settings
  isActive: boolean('is_active').default(true),
  priority: integer('priority').default(0),

  // Temperature/Environment
  temperatureControlled: boolean('temperature_controlled').default(false),
  minTemperature: integer('min_temperature'),
  maxTemperature: integer('max_temperature'),
  temperatureUnit: varchar('temperature_unit', { length: 5 }).default('C'),

  // Capacity
  totalLocations: integer('total_locations').default(0),

  // Picking Configuration
  pickingSequence: integer('picking_sequence').default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('warehouse_zones_warehouse_idx').on(table.warehouseId),
  index('warehouse_zones_code_idx').on(table.code),
  index('warehouse_zones_type_idx').on(table.zoneType),
]);

export type WarehouseZone = typeof warehouseZones.$inferSelect;
export type NewWarehouseZone = typeof warehouseZones.$inferInsert;

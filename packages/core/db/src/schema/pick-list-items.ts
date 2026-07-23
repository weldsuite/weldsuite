import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Pick List Items - Individual items to pick
export const pickListItems = pgTable('pick_list_items', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  pickListId: varchar('pick_list_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Order Reference
  orderId: varchar('order_id', { length: 30 }),
  orderItemId: varchar('order_item_id', { length: 30 }),

  // Product Reference
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  sku: varchar('sku', { length: 100 }),
  name: varchar('name', { length: 255 }).notNull(),

  // Location
  locationId: varchar('location_id', { length: 30 }),
  locationCode: varchar('location_code', { length: 50 }),
  inventoryId: varchar('inventory_id', { length: 30 }),

  // Quantities
  quantityRequired: integer('quantity_required').notNull().default(1),
  quantityPicked: integer('quantity_picked').default(0),
  quantityShort: integer('quantity_short').default(0),

  // Lot/Batch
  lotNumber: varchar('lot_number', { length: 100 }),
  batchNumber: varchar('batch_number', { length: 100 }),
  expiryDate: timestamp('expiry_date'),

  // Status
  status: varchar('status', { length: 30 }).default('pending'), // pending, picked, partial, short, skipped

  // Picking
  pickSequence: integer('pick_sequence').default(0),
  pickedAt: timestamp('picked_at'),
  pickedBy: varchar('picked_by', { length: 255 }),

  // Substitution
  isSubstituted: integer('is_substituted').default(0),
  originalProductId: varchar('original_product_id', { length: 30 }),
  substitutionReason: text('substitution_reason'),

  // Notes
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('pick_list_items_list_idx').on(table.pickListId),
  index('pick_list_items_order_idx').on(table.orderId),
  index('pick_list_items_product_idx').on(table.productId),
  index('pick_list_items_location_idx').on(table.locationId),
  index('pick_list_items_status_idx').on(table.status),
]);

export type PickListItem = typeof pickListItems.$inferSelect;
export type NewPickListItem = typeof pickListItems.$inferInsert;

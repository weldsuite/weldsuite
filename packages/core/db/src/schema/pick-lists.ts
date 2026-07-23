import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Pick Lists - Lists of items to pick for order fulfillment
export const pickLists = pgTable('pick_lists', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  pickListNumber: varchar('pick_list_number', { length: 50 }).notNull(),

  // Warehouse
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('pending'), // pending, assigned, in_progress, completed, cancelled

  // Priority
  priority: varchar('priority', { length: 20 }).default('normal'), // low, normal, high, urgent

  // Assignment
  assignedTo: varchar('assigned_to', { length: 255 }),
  assignedToName: varchar('assigned_to_name', { length: 255 }),
  assignedAt: timestamp('assigned_at'),

  // Progress
  totalItems: integer('total_items').default(0),
  pickedItems: integer('picked_items').default(0),
  totalQuantity: integer('total_quantity').default(0),
  pickedQuantity: integer('picked_quantity').default(0),

  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  dueDate: timestamp('due_date'),

  // Source Orders
  orderIds: jsonb('order_ids').$type<string[]>(),
  orderCount: integer('order_count').default(0),

  // Pick Type
  pickType: varchar('pick_type', { length: 30 }).default('order'), // order, wave, batch, zone

  // Notes
  notes: text('notes'),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('pick_lists_number_idx').on(table.pickListNumber),
  index('pick_lists_warehouse_idx').on(table.warehouseId),
  index('pick_lists_status_idx').on(table.status),
  index('pick_lists_assigned_idx').on(table.assignedTo),
  index('pick_lists_created_idx').on(table.createdAt),
]);

export type PickList = typeof pickLists.$inferSelect;
export type NewPickList = typeof pickLists.$inferInsert;

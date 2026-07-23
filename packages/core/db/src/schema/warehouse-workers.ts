import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Warehouse Workers - Pickers and other warehouse staff
export const warehouseWorkers = pgTable('warehouse_workers', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // User Reference
  userId: varchar('user_id', { length: 30 }),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),

  // Warehouse Assignment
  warehouseId: varchar('warehouse_id', { length: 30 }),

  // Role & Status
  role: varchar('role', { length: 50 }).default('picker'),
  status: varchar('status', { length: 20 }).default('active'), // active|inactive|on_break

  // Skills & Notes
  skills: jsonb('skills').$type<string[]>(),
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('warehouse_workers_warehouse_idx').on(table.warehouseId),
  index('warehouse_workers_status_idx').on(table.status),
]);

export type WarehouseWorker = typeof warehouseWorkers.$inferSelect;
export type NewWarehouseWorker = typeof warehouseWorkers.$inferInsert;

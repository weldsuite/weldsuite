import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Activity Logs - Append-only WMS audit log (no deletedAt)
export const activityLogs = pgTable('activity_logs', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Activity Type
  // create|update|delete|receive|ship|pick|pack|adjust|transfer
  activityType: varchar('activity_type', { length: 50 }).notNull(),

  // Entity Reference
  entityType: varchar('entity_type', { length: 50 }),
  entityId: varchar('entity_id', { length: 30 }),

  // Actor
  userId: varchar('user_id', { length: 30 }),
  warehouseId: varchar('warehouse_id', { length: 30 }),

  // Details
  description: text('description'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('activity_logs_entity_idx').on(table.entityType, table.entityId),
  index('activity_logs_user_idx').on(table.userId),
  index('activity_logs_warehouse_idx').on(table.warehouseId),
  index('activity_logs_created_idx').on(table.createdAt),
]);

export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;

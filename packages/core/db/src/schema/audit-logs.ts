import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const auditLogs = pgTable('audit_logs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // What changed
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),
  action: varchar('action', { length: 50 }).notNull(),
  description: text('description').notNull(),

  // Structured change data
  changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),

  // Full entity snapshot at the time of the event
  data: jsonb('data').$type<Record<string, unknown>>(),

  // Who did it
  performedBy: varchar('performed_by', { length: 255 }),
  performedByName: varchar('performed_by_name', { length: 255 }),

  // Optional compliance fields
  ipAddress: varchar('ip_address', { length: 45 }),

  // Extra context
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('audit_logs_entity_idx').on(table.entityType, table.entityId),
  index('audit_logs_created_at_idx').on(table.createdAt),
  index('audit_logs_performed_by_idx').on(table.performedBy),
]);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

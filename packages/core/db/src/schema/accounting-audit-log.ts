import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const auditLog = pgTable('audit_log', {
  id: varchar('id', { length: 30 }).primaryKey(),

  accountingEntityId: varchar('accounting_entity_id', { length: 30 }),
  entityType: varchar('entity_type', { length: 30 }).notNull(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  changes: jsonb('changes').$type<Record<string, { old: unknown; new: unknown }>>(),
  userId: varchar('user_id', { length: 255 }),
  userEmail: varchar('user_email', { length: 255 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
}, (table) => [
  index('acct_audit_log_accounting_entity_idx').on(table.accountingEntityId),
  index('acct_audit_log_entity_idx').on(table.entityType, table.entityId),
  index('acct_audit_log_user_idx').on(table.userId),
  index('acct_audit_log_timestamp_idx').on(table.timestamp),
  index('acct_audit_log_action_idx').on(table.action),
]);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

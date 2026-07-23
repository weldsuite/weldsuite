import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const reconciliationRules = pgTable('reconciliation_rules', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  priority: integer('priority').default(0),
  isActive: boolean('is_active').default(true),
  matchMode: varchar('match_mode', { length: 5 }).default('all'),

  conditions: jsonb('conditions').$type<Array<{
    field: 'description' | 'counterpartyName' | 'counterpartyIban' | 'amount' | 'reference';
    operator: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than' | 'between';
    value: string | number;
    value2?: number;
  }>>(),

  actions: jsonb('actions').$type<{
    categoryAccountId?: string;
    taxRateId?: string;
    contactId?: string;
    description?: string;
  }>(),

  matchCount: integer('match_count').default(0),
  lastMatchedAt: timestamp('last_matched_at'),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_recon_rules_entity_idx').on(table.entityId),
  index('acct_recon_rules_is_active_idx').on(table.isActive),
  index('acct_recon_rules_priority_idx').on(table.priority),
]);

export type ReconciliationRule = typeof reconciliationRules.$inferSelect;
export type NewReconciliationRule = typeof reconciliationRules.$inferInsert;

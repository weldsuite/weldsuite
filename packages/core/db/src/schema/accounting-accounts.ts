import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  code: varchar('code', { length: 20 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 20 }).notNull(),
  subtype: varchar('subtype', { length: 50 }),
  parentAccountId: varchar('parent_account_id', { length: 30 }),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  isActive: boolean('is_active').default(true),
  isSystemAccount: boolean('is_system_account').default(false),
  openingBalance: numeric('opening_balance', { precision: 18, scale: 2 }).default('0'),
  currentBalance: numeric('current_balance', { precision: 18, scale: 2 }).default('0'),
  normalSide: varchar('normal_side', { length: 6 }).notNull(),
  defaultTaxRateId: varchar('default_tax_rate_id', { length: 30 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_accounts_entity_idx').on(table.entityId),
  index('acct_accounts_code_idx').on(table.code),
  index('acct_accounts_type_idx').on(table.type),
  index('acct_accounts_parent_idx').on(table.parentAccountId),
  index('acct_accounts_is_active_idx').on(table.isActive),
]);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

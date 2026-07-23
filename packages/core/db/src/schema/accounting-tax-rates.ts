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

/**
 * Generic tax categories resolved by a JurisdictionAdapter.
 * Jurisdiction-specific codes (NL btwRubriek, DE Umsatzsteuer, GB VAT scheme) live in `jurisdictionMetadata`.
 */
export type TaxCategoryCode =
  | 'standard'
  | 'reduced'
  | 'super_reduced'
  | 'zero'
  | 'exempt'
  | 'reverse_charge'
  | 'eu_b2b_service'
  | 'eu_b2c_distance'
  | 'export_goods'
  | 'import_goods';

export const taxRates = pgTable('tax_rates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  jurisdictionCode: varchar('jurisdiction_code', { length: 5 }).notNull(),

  name: varchar('name', { length: 100 }).notNull(),
  rate: numeric('rate', { precision: 5, scale: 2 }).notNull(),
  type: varchar('type', { length: 10 }).notNull(),
  taxCategoryCode: varchar('tax_category_code', { length: 30 }).$type<TaxCategoryCode>(),
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
  description: text('description'),
  ledgerAccountId: varchar('ledger_account_id', { length: 30 }),

  jurisdictionMetadata: jsonb('jurisdiction_metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_tax_rates_entity_idx').on(table.entityId),
  index('acct_tax_rates_jurisdiction_idx').on(table.jurisdictionCode),
  index('acct_tax_rates_type_idx').on(table.type),
  index('acct_tax_rates_category_idx').on(table.taxCategoryCode),
  index('acct_tax_rates_is_active_idx').on(table.isActive),
]);

export type TaxRate = typeof taxRates.$inferSelect;
export type NewTaxRate = typeof taxRates.$inferInsert;

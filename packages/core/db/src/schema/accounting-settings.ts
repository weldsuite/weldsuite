import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

/**
 * Workspace-wide accounting settings (singleton row).
 * Entity-specific identity (company details, tax IDs, numbering, branding, jurisdiction filing
 * credentials) lives on the `entities` table and its related tables. This row only tracks
 * workspace-level defaults and shared inputs.
 */
export const settings = pgTable('settings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  defaultEntityId: varchar('default_entity_id', { length: 30 }),
  accountingMethod: varchar('accounting_method', { length: 10 }).default('accrual'),
  defaultPaymentTermsDays: integer('default_payment_terms_days').default(30),
  fiscalYearStart: integer('fiscal_year_start').default(1),

  emailSettings: jsonb('email_settings').$type<{
    inboxAddress?: string;
    autoScanEnabled?: boolean;
    autoCreateDraftBills?: boolean;
  }>(),
});

export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;

import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { StoredPostalAddress } from './accounting-address';

export const entities = pgTable('entities', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 255 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }),
  entityType: varchar('entity_type', { length: 20 }),
  jurisdictionCode: varchar('jurisdiction_code', { length: 5 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 3 }).notNull().default('EUR'),
  locale: varchar('locale', { length: 10 }).notNull().default('nl-NL'),
  timezone: varchar('timezone', { length: 50 }).default('Europe/Amsterdam'),

  taxIdentifiers: jsonb('tax_identifiers').$type<{
    vatNumber?: string;
    registrationNumber?: string;
    einOrSsn?: string;
    other?: Record<string, string>;
  }>(),

  address: jsonb('address').$type<StoredPostalAddress>(),

  contact: jsonb('contact').$type<{
    email?: string;
    phone?: string;
    website?: string;
  }>(),

  bankDetails: jsonb('bank_details').$type<{
    iban?: string;
    bic?: string;
    accountNumber?: string;
    routingNumber?: string;
    bankName?: string;
  }>(),

  branding: jsonb('branding').$type<{
    logoUrl?: string;
    primaryColor?: string;
    accentColor?: string;
    footerText?: string;
    paymentInstructions?: string;
    termsAndConditions?: string;
  }>(),

  jurisdictionSettings: jsonb('jurisdiction_settings').$type<Record<string, unknown>>(),

  fiscalYearStart: integer('fiscal_year_start').default(1),

  /**
   * Lock dates: postings dated on or before a lock date are refused.
   * sales = invoices and credit notes; purchase = bills; tax = anything that
   * carries tax (set when a tax return is filed); period = everything. Each
   * of these can be bypassed by a logged `lock_date_exceptions` row. The hard
   * lock has no exceptions and can only move forward.
   */
  salesLockDate: date('sales_lock_date'),
  purchaseLockDate: date('purchase_lock_date'),
  taxLockDate: date('tax_lock_date'),
  periodLockDate: date('period_lock_date'),
  hardLockDate: date('hard_lock_date'),

  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
}, (table) => [
  index('entities_jurisdiction_idx').on(table.jurisdictionCode),
  index('entities_is_default_idx').on(table.isDefault),
  index('entities_is_active_idx').on(table.isActive),
]);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

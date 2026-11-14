/**
 * WeldBooks' extension of a legal entity (weldsuite-documentation/plans/legal-entities.md).
 *
 * The legal entity itself (`entities`) is core and lives in
 * ./legal-entities.ts. A row here means "WeldBooks is enabled for this
 * entity" and holds how WeldBooks works with the company: lock dates,
 * accounting method, sales tax engine, the owner's SSN, document texts and
 * the account printed on invoices. Release 1 mirrors these columns to the
 * old ones on `entities`; release 2 drops those.
 */

import {
  pgTable,
  varchar,
  timestamp,
  date,
  text,
  jsonb,
} from 'drizzle-orm/pg-core';

export interface AccountingDocumentTexts {
  footerText?: string;
  paymentInstructions?: string;
  termsAndConditions?: string;
}

export const accountingEntitySettings = pgTable('accounting_entity_settings', {
  /** `entities.id`; one row per entity WeldBooks is enabled for. */
  entityId: varchar('entity_id', { length: 30 }).primaryKey(),

  salesLockDate: date('sales_lock_date'),
  purchaseLockDate: date('purchase_lock_date'),
  taxLockDate: date('tax_lock_date'),
  periodLockDate: date('period_lock_date'),
  hardLockDate: date('hard_lock_date'),

  /** Default report basis: accrual | cash. Falls back to settings.accounting_method. */
  accountingMethod: varchar('accounting_method', { length: 10 }),
  /** US sales tax engine: manual | stripe_tax | avalara. */
  salesTaxEngine: varchar('sales_tax_engine', { length: 30 }),
  /** Non-secret engine settings (Avalara company code and environment, ...). */
  salesTaxEngineConfig: jsonb('sales_tax_engine_config').$type<Record<string, unknown>>(),
  /** AES-GCM blob of the engine credentials (the customer's own key). Never returned. */
  salesTaxCredentialsEncrypted: text('sales_tax_credentials_encrypted'),
  /** Brazil: the fiscal document provider's API token (Focus NFe), sealed like the sales tax credentials. */
  fiscalCredentialsEncrypted: text('fiscal_credentials_encrypted'),
  /** AES-GCM blob of the owner's SSN, for a sole proprietor without an EIN. Only WeldBooks uses it. */
  ssnEncrypted: text('ssn_encrypted'),
  ssnLast4: varchar('ssn_last4', { length: 4 }),
  /** KOR, IN state code and other per-jurisdiction WeldBooks switches. */
  jurisdictionSettings: jsonb('jurisdiction_settings').$type<Record<string, unknown>>(),

  /** Core `bank_accounts.id` printed on invoices. */
  invoiceBankAccountId: varchar('invoice_bank_account_id', { length: 30 }),
  documentTexts: jsonb('document_texts').$type<AccountingDocumentTexts>(),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type AccountingEntitySettings = typeof accountingEntitySettings.$inferSelect;
export type NewAccountingEntitySettings = typeof accountingEntitySettings.$inferInsert;

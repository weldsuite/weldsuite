import {
  pgTable,
  varchar,
  timestamp,
  date,
  boolean,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Tax ledger: one row per tax amount a posted document or journal entry
 * carries, written in the same batch as its journal entry.
 *
 * Every tax return and tax report reads this table rather than journal lines.
 * Rows are never updated except to stamp `taxReturnId` when a return that
 * includes them is filed; corrections (credit notes, reversals) write rows with
 * negative amounts.
 */
export const taxLines = pgTable('tax_lines', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** invoice | credit_note | bill | bill_credit_note | journal | bank_transaction | reversal */
  sourceType: varchar('source_type', { length: 30 }).notNull(),
  sourceId: varchar('source_id', { length: 30 }),
  sourceLineId: varchar('source_line_id', { length: 30 }),
  journalEntryId: varchar('journal_entry_id', { length: 30 }).notNull(),
  /** The tax point: the date the amount counts for on a return. */
  taxDate: date('tax_date').notNull(),
  /** sales = tax charged to customers; purchase = tax paid to suppliers (or self-assessed). */
  direction: varchar('direction', { length: 10 }).notNull(),

  taxRateId: varchar('tax_rate_id', { length: 30 }),
  taxRateName: varchar('tax_rate_name', { length: 100 }),
  taxCategoryCode: varchar('tax_category_code', { length: 30 }),
  rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
  /** Component of a split tax, e.g. India's cgst / sgst / igst. */
  component: varchar('component', { length: 20 }),
  /** Purchase tax the buyer accounts for itself (reverse charge, imports). */
  selfAssessed: boolean('self_assessed').notNull().default(false),

  /** Jurisdiction detail for taxes levied per location (US state, county, city). */
  jurisdictionCode: varchar('jurisdiction_code', { length: 30 }),
  jurisdictionLevel: varchar('jurisdiction_level', { length: 20 }),
  stateCode: varchar('state_code', { length: 10 }),

  /** Amounts in the document currency, signed (negative on credit notes and reversals). */
  taxableAmount: numeric('taxable_amount', { precision: 18, scale: 2 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  /** The same amounts in the entity's base currency. */
  baseTaxableAmount: numeric('base_taxable_amount', { precision: 18, scale: 2 }).notNull(),
  baseTaxAmount: numeric('base_tax_amount', { precision: 18, scale: 2 }).notNull(),

  /** Counterparty (parties.id), for per-buyer reporting such as the EU ICP listing. */
  contactId: varchar('contact_id', { length: 30 }),

  /** Set when a filed return includes this row, so a filed period can't change under it. */
  taxReturnId: varchar('tax_return_id', { length: 30 }),
}, (table) => [
  index('acct_tax_lines_entity_date_idx').on(table.entityId, table.taxDate),
  index('acct_tax_lines_source_idx').on(table.sourceType, table.sourceId),
  index('acct_tax_lines_journal_entry_idx').on(table.journalEntryId),
  index('acct_tax_lines_tax_rate_idx').on(table.taxRateId),
  index('acct_tax_lines_tax_return_idx').on(table.taxReturnId),
]);

export type TaxLine = typeof taxLines.$inferSelect;
export type NewTaxLine = typeof taxLines.$inferInsert;

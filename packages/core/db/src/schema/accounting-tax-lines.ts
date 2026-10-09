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
 * One row of a document's `tax_breakdown`: a tax amount per rate (VAT/GST) or
 * per jurisdiction and line (US sales tax), as the tax calculation returned it.
 */
export interface DocumentTaxBreakdownRow {
  taxRateId: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  /** GST component when expanded (cgst / sgst / igst). */
  component?: string;
  /** System account role for journal posting. */
  accountRole?: string;
  /** The rate's tax category (standard, reduced, reverse_charge, ...). */
  taxCategoryCode?: string;
  /** Purchase tax the buyer self-assesses (reverse charge, imports, US use tax): not owed to the supplier. */
  selfAssessed?: boolean;
  /** US sales tax: the document line this row belongs to. */
  lineId?: string;
  /** US sales tax: jurisdiction (FIPS / SST code) and its name and level. */
  jurisdictionCode?: string;
  jurisdictionName?: string;
  jurisdictionLevel?: 'state' | 'county' | 'city' | 'district';
  stateCode?: string;
  agencyId?: string;
  /** The state's location code for the return. */
  reportingCode?: string;
  /** Part of the line that is exempt (certificate) or not taxable (product taxability). */
  exemptAmount?: number;
  nonTaxableAmount?: number;
  exemptReason?: string;
  certificateId?: string;
  /** Tax before rounding to the cent, so returns reconcile. */
  unroundedTaxAmount?: number;
  /** WeldBooks product tax code of the line. */
  taxCode?: string;
  /** use = US use tax accrued on a purchase. */
  kind?: 'tax' | 'use';
}

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
  /** sales = tax charged to customers; purchase = tax paid to suppliers (or self-assessed); use = US use tax accrued. */
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

  /** US sales tax detail (null for VAT/GST rows). */
  agencyId: varchar('agency_id', { length: 30 }),
  jurisdictionName: varchar('jurisdiction_name', { length: 255 }),
  reportingCode: varchar('reporting_code', { length: 30 }),
  /** Line amount before exemptions; taxable + exempt + non-taxable = gross. */
  grossAmount: numeric('gross_amount', { precision: 18, scale: 2 }),
  exemptAmount: numeric('exempt_amount', { precision: 18, scale: 2 }),
  nonTaxableAmount: numeric('non_taxable_amount', { precision: 18, scale: 2 }),
  exemptReason: varchar('exempt_reason', { length: 30 }),
  certificateId: varchar('certificate_id', { length: 30 }),
  shipToState: varchar('ship_to_state', { length: 10 }),
  shipToPostalCode: varchar('ship_to_postal_code', { length: 10 }),
  taxCode: varchar('tax_code', { length: 30 }),
  /** Sold through a marketplace facilitator: counts toward nexus, no tax charged. */
  marketplaceFacilitated: boolean('marketplace_facilitated').notNull().default(false),
  unroundedTaxAmount: numeric('unrounded_tax_amount', { precision: 18, scale: 6 }),
  /** Engine that calculated it (manual, stripe_tax, avalara) and its reference. */
  engine: varchar('engine', { length: 30 }),
  engineRef: varchar('engine_ref', { length: 255 }),
}, (table) => [
  index('acct_tax_lines_agency_date_idx').on(table.agencyId, table.taxDate),
  index('acct_tax_lines_entity_date_idx').on(table.entityId, table.taxDate),
  index('acct_tax_lines_source_idx').on(table.sourceType, table.sourceId),
  index('acct_tax_lines_journal_entry_idx').on(table.journalEntryId),
  index('acct_tax_lines_tax_rate_idx').on(table.taxRateId),
  index('acct_tax_lines_tax_return_idx').on(table.taxReturnId),
]);

export type TaxLine = typeof taxLines.$inferSelect;
export type NewTaxLine = typeof taxLines.$inferInsert;

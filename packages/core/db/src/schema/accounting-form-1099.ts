import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  boolean,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/** One 1099 form type for one tax year of an entity (NEC and MISC are separate filings). */
export const form1099Filings = pgTable('form_1099_filings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  taxYear: integer('tax_year').notNull(),
  /** nec | misc */
  formType: varchar('form_type', { length: 10 }).notNull(),
  /** draft | reviewed | generated | filed | corrected */
  status: varchar('status', { length: 15 }).notNull().default('draft'),
  generatedAt: timestamp('generated_at'),
  filedAt: timestamp('filed_at'),
  /** IRIS receipt id or the confirmation the user got when uploading. */
  confirmationNumber: varchar('confirmation_number', { length: 255 }),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_1099_filings_entity_year_idx').on(table.entityId, table.taxYear),
]);

/**
 * One recipient on a filing. Amounts per box come from the yearly
 * computation plus manual adjustments. The recipient's TIN is copied in
 * encrypted at generation, so the filed form keeps the TIN it was filed with.
 */
export const form1099FilingLines = pgTable('form_1099_filing_lines', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  filingId: varchar('filing_id', { length: 30 }).notNull(),
  partyId: varchar('party_id', { length: 30 }).notNull(),
  /** Name, address, TIN type and last four at generation; never the full TIN. */
  recipient: jsonb('recipient').$type<{
    name: string;
    businessName?: string;
    address?: Record<string, string | undefined>;
    tinType?: string;
    tinLast4?: string;
    accountNumber?: string;
  }>(),
  recipientTinEncrypted: text('recipient_tin_encrypted'),
  /** Box code → amount, e.g. { nec_1: 4200, nec_4: 0 }. */
  boxes: jsonb('boxes').$type<Record<string, number>>().notNull(),
  adjustments: jsonb('adjustments').$type<Array<{ box: string; amount: number; reason: string; by?: string; at?: string }>>(),
  federalWithheld: numeric('federal_withheld', { precision: 18, scale: 2 }).default('0'),
  stateCode: varchar('state_code', { length: 2 }),
  stateIdNumber: varchar('state_id_number', { length: 50 }),
  stateIncome: numeric('state_income', { precision: 18, scale: 2 }),
  stateWithheld: numeric('state_withheld', { precision: 18, scale: 2 }),
  /** included | excluded | needs_tin | needs_address */
  status: varchar('status', { length: 15 }).notNull().default('included'),
  excludedReason: varchar('excluded_reason', { length: 255 }),
  isCorrected: boolean('is_corrected').notNull().default(false),
  correctionOfLineId: varchar('correction_of_line_id', { length: 30 }),
  /** print | email */
  deliveryMethod: varchar('delivery_method', { length: 10 }),
  deliveredAt: timestamp('delivered_at'),
}, (table) => [
  index('acct_1099_lines_filing_idx').on(table.filingId),
  index('acct_1099_lines_party_idx').on(table.partyId),
]);

/**
 * Append-only log of every reveal of a full TIN, SSN or bank account number.
 * Rows are never updated or deleted.
 */
export const taxIdReveals = pgTable('tax_id_reveals', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }),
  /** party | entity | bank_account | form_1099_line */
  subjectType: varchar('subject_type', { length: 20 }).notNull(),
  subjectId: varchar('subject_id', { length: 30 }).notNull(),
  /** tin | ssn | account_number | ach_account_number */
  field: varchar('field', { length: 30 }).notNull(),
  revealedBy: varchar('revealed_by', { length: 255 }).notNull(),
  reason: varchar('reason', { length: 255 }),
}, (table) => [
  index('acct_tax_id_reveals_subject_idx').on(table.subjectType, table.subjectId),
  index('acct_tax_id_reveals_created_idx').on(table.createdAt),
]);

export type Form1099Filing = typeof form1099Filings.$inferSelect;
export type NewForm1099Filing = typeof form1099Filings.$inferInsert;
export type Form1099FilingLine = typeof form1099FilingLines.$inferSelect;
export type NewForm1099FilingLine = typeof form1099FilingLines.$inferInsert;
export type TaxIdReveal = typeof taxIdReveals.$inferSelect;
export type NewTaxIdReveal = typeof taxIdReveals.$inferInsert;

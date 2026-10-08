import {
  pgTable,
  varchar,
  timestamp,
  date,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export interface TaxReturnAdjustment {
  type: 'vendor_discount' | 'prepayment' | 'penalty' | 'interest' | 'rounding' | 'other';
  /** Positive increases what is paid, negative reduces it. */
  amount: number;
  note?: string;
}

/**
 * Generic tax return per agency and period (US sales tax first; NL keeps
 * `vat_returns` until it moves over). Built from `tax_lines`; filing stamps
 * the rows it includes with this id, so a filed period can't change under it.
 */
export const taxReturns = pgTable('tax_returns', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  jurisdictionCode: varchar('jurisdiction_code', { length: 5 }).notNull(),
  agencyId: varchar('agency_id', { length: 30 }),
  stateCode: varchar('state_code', { length: 10 }),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  dueDate: date('due_date'),
  /** open | calculated | reviewed | filed | paid */
  status: varchar('status', { length: 15 }).notNull().default('open'),
  /** accrual | cash */
  reportingBasis: varchar('reporting_basis', { length: 10 }).notNull().default('accrual'),

  /** The worksheet: gross sales, deductions by reason, taxable sales, tax and use tax due. */
  summary: jsonb('summary').$type<Record<string, unknown>>(),
  /** Tax by reporting location (county, city, district). */
  lines: jsonb('lines').$type<Array<Record<string, unknown>>>(),
  adjustments: jsonb('adjustments').$type<TaxReturnAdjustment[]>(),
  /** Changes to the period after filing (late credit memos, voids) and pre-file check findings. */
  exceptions: jsonb('exceptions').$type<Array<Record<string, unknown>>>(),
  /** Tax due plus adjustments. */
  totalDue: numeric('total_due', { precision: 18, scale: 2 }).default('0'),

  filedAt: timestamp('filed_at'),
  filedBy: varchar('filed_by', { length: 255 }),
  confirmationNumber: varchar('confirmation_number', { length: 255 }),
  paidAt: timestamp('paid_at'),
  paymentAmount: numeric('payment_amount', { precision: 18, scale: 2 }),
  paymentBankAccountId: varchar('payment_bank_account_id', { length: 30 }),
  paymentJournalEntryId: varchar('payment_journal_entry_id', { length: 30 }),
  amendsReturnId: varchar('amends_return_id', { length: 30 }),
  notes: text('notes'),
}, (table) => [
  index('acct_tax_returns_entity_idx').on(table.entityId),
  index('acct_tax_returns_agency_period_idx').on(table.agencyId, table.periodStart),
  index('acct_tax_returns_status_idx').on(table.status),
]);

export type TaxReturn = typeof taxReturns.$inferSelect;
export type NewTaxReturn = typeof taxReturns.$inferInsert;

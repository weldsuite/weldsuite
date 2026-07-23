import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export interface VatRubrieken {
  r1a: number;
  r1b: number;
  r1c: number;
  r1d: number;
  r1e: number;
  r1f: number;
  r2a: number;
  r3a: number;
  r3b: number;
  r3c: number;
  r4a: number;
  r4b: number;
  r5a: number;
  r5b: number;
  r5c: number;
  r5d: number;
  r5e: number;
  r5f: number;
}

export const vatReturns = pgTable('vat_returns', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  periodType: varchar('period_type', { length: 10 }).notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  periodLabel: varchar('period_label', { length: 50 }),

  status: varchar('status', { length: 15 }).default('draft').notNull(),

  rubrieken: jsonb('rubrieken').$type<VatRubrieken>(),

  supportingData: jsonb('supporting_data').$type<{
    transactionIds?: string[];
    journalEntryIds?: string[];
  }>(),

  xmlContent: text('xml_content'),
  filingReference: varchar('filing_reference', { length: 255 }),
  digipoortResponse: jsonb('digipoort_response').$type<Record<string, unknown>>(),

  filedAt: timestamp('filed_at'),
  filedBy: varchar('filed_by', { length: 255 }),
  acceptedAt: timestamp('accepted_at'),
  rejectedAt: timestamp('rejected_at'),
  rejectionReason: text('rejection_reason'),

  correctionOfId: varchar('correction_of_id', { length: 30 }),
  /**
   * Suppletie deadline: since 2025 a discovered error > €1,000 must be
   * corrected within 8 weeks of discovery. Set when a suppletie return is
   * created; surfaced in the VAT UI as a hard deadline.
   */
  suppletieDeadline: timestamp('suppletie_deadline'),
  notes: text('notes'),
}, (table) => [
  index('acct_vat_returns_entity_idx').on(table.entityId),
  index('acct_vat_returns_period_start_idx').on(table.periodStart),
  index('acct_vat_returns_period_end_idx').on(table.periodEnd),
  index('acct_vat_returns_status_idx').on(table.status),
  index('acct_vat_returns_period_type_idx').on(table.periodType),
]);

export type VatReturn = typeof vatReturns.$inferSelect;
export type NewVatReturn = typeof vatReturns.$inferInsert;

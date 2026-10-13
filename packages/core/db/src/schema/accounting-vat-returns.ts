import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * The boxes (rubrieken) of the Dutch aangifte omzetbelasting, as the
 * Belastingdienst numbers them. A key like `r1a` holds the omzet (turnover) of
 * that box; where the box also has a BTW column it is `r1aBtw`.
 *
 *   1a hoog tarief, 1b laag tarief, 1c overige tarieven (behalve 0%),
 *   1d privégebruik            omzet + BTW
 *   1e 0% of niet bij u belast omzet only
 *   2a verleggingsregelingen binnenland          omzet + BTW
 *   3a buiten de EU, 3b binnen de EU, 3c installatie/afstandsverkopen  omzet only
 *   4a uit landen buiten de EU, 4b uit landen binnen de EU            omzet + BTW
 *   5a verschuldigde BTW, 5b voorbelasting, 5c subtotaal, 5d vermindering KOR,
 *   5e schatting vorige aangifte(n), 5f schatting deze aangifte,
 *   5g totaal te betalen / terug te vragen
 *
 * Returns stored before this layout (`r1a`..`r1f`, `r5f` as the total) are
 * converted on read by `normalizeVatRubrieken` in `@weldsuite/books-domain`.
 */
export interface VatRubrieken {
  r1a: number;
  r1aBtw: number;
  r1b: number;
  r1bBtw: number;
  r1c: number;
  r1cBtw: number;
  r1d: number;
  r1dBtw: number;
  r1e: number;
  r2a: number;
  r2aBtw: number;
  r3a: number;
  r3b: number;
  r3c: number;
  r4a: number;
  r4aBtw: number;
  r4b: number;
  r4bBtw: number;
  r5a: number;
  r5b: number;
  r5c: number;
  r5d: number;
  r5e: number;
  r5f: number;
  r5g: number;
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

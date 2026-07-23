import {
  pgTable,
  varchar,
  timestamp,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Opgaaf ICP (intracommunautaire prestaties) declarations.
 *
 * Required alongside the BTW-aangifte whenever the entity has 0%-rated EU B2B
 * supplies (rubriek 3a/3b): a per-customer listing of VAT number, country and
 * net amount, split by goods / services / triangulation. Filed via the same
 * SBR/Digipoort channel as the VAT return, on the same cadence.
 */
export const icpDeclarations = pgTable('icp_declarations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  periodType: varchar('period_type', { length: 10 }).notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  periodLabel: varchar('period_label', { length: 50 }),

  /** calculated → reviewed → filed → accepted / rejected */
  status: varchar('status', { length: 15 }).notNull().default('calculated'),

  /** Sum of all line amounts, for list display. */
  totalAmount: numeric('total_amount', { precision: 15, scale: 2 }).notNull().default('0'),

  /** Generated XBRL, stored on filing for the audit trail. */
  xmlContent: text('xml_content'),
  /** Digipoort kenmerk. */
  filingReference: varchar('filing_reference', { length: 100 }),
  digipoortResponse: jsonb('digipoort_response').$type<Record<string, unknown>>(),
  filedAt: timestamp('filed_at'),
  filedBy: varchar('filed_by', { length: 255 }),
  acceptedAt: timestamp('accepted_at'),
  rejectedAt: timestamp('rejected_at'),
  rejectionReason: text('rejection_reason'),
  notes: text('notes'),
}, (table) => [
  index('acct_icp_declarations_entity_idx').on(table.entityId),
  index('acct_icp_declarations_period_idx').on(table.periodStart, table.periodEnd),
  index('acct_icp_declarations_status_idx').on(table.status),
]);

/**
 * Per-customer lines of an ICP declaration.
 */
export const icpLines = pgTable('icp_lines', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  declarationId: varchar('declaration_id', { length: 30 }).notNull(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),

  /** Accounting contact (party) this line aggregates, when known. */
  contactId: varchar('contact_id', { length: 30 }),
  /** Buyer VAT number (full, e.g. DE123456789) — the ICP key field. */
  vatNumber: varchar('vat_number', { length: 20 }).notNull(),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  /** goods | services | triangulation — separate ICP indicators. */
  supplyType: varchar('supply_type', { length: 15 }).notNull().default('goods'),
  amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
}, (table) => [
  index('acct_icp_lines_declaration_idx').on(table.declarationId),
  index('acct_icp_lines_entity_idx').on(table.entityId),
  index('acct_icp_lines_vat_number_idx').on(table.vatNumber),
]);

export type IcpDeclaration = typeof icpDeclarations.$inferSelect;
export type NewIcpDeclaration = typeof icpDeclarations.$inferInsert;
export type IcpLine = typeof icpLines.$inferSelect;
export type NewIcpLine = typeof icpLines.$inferInsert;

import {
  pgTable,
  varchar,
  timestamp,
  date,
  boolean,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Values of the line-level reporting dimensions: classes (departments,
 * product lines) and locations. Invoice, bill and journal lines carry
 * `class_id` / `location_id`, and every report can filter or split by them.
 */
export const accountingDimensionValues = pgTable('accounting_dimension_values', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** class | location */
  dimension: varchar('dimension', { length: 10 }).notNull(),
  code: varchar('code', { length: 30 }),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: varchar('parent_id', { length: 30 }),
  isActive: boolean('is_active').notNull().default(true),
}, (table) => [
  index('acct_dimension_values_entity_idx').on(table.entityId, table.dimension),
]);

/**
 * A payroll provider connection (Gusto first). Payroll itself stays with the
 * provider; WeldBooks imports each payroll's journal.
 */
export const payrollConnections = pgTable('payroll_connections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** gusto */
  provider: varchar('provider', { length: 20 }).notNull(),
  providerCompanyId: varchar('provider_company_id', { length: 100 }),
  /** AES-GCM blob of the access token. Never returned. */
  credentialsEncrypted: text('credentials_encrypted'),
  /** Provider payroll category → WeldBooks account id. */
  accountMapping: jsonb('account_mapping').$type<Record<string, string>>(),
  /** active | error | disconnected */
  status: varchar('status', { length: 15 }).notNull().default('active'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
}, (table) => [
  index('acct_payroll_connections_entity_idx').on(table.entityId),
]);

/** One imported payroll (CSV or provider), posted as one journal entry. */
export const payrollImports = pgTable('payroll_imports', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** csv | gusto */
  source: varchar('source', { length: 10 }).notNull(),
  connectionId: varchar('connection_id', { length: 30 }),
  /** The provider's payroll id; unique per source so a payroll imports once. */
  externalId: varchar('external_id', { length: 100 }),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  payDate: date('pay_date').notNull(),
  /** Category → amount, e.g. { gross_wages: 10000, employer_taxes: 765, net_pay: 7600 }. */
  summary: jsonb('summary').$type<Record<string, number>>(),
  /** posted | reversed */
  status: varchar('status', { length: 10 }).notNull().default('posted'),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  sourceFileName: varchar('source_file_name', { length: 255 }),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_payroll_imports_entity_idx').on(table.entityId, table.payDate),
  uniqueIndex('acct_payroll_imports_external_uidx').on(table.entityId, table.source, table.externalId),
]);

/** Deadlines on the tax calendar the user marked as done (the calendar itself is computed). */
export const taxCalendarCompletions = pgTable('tax_calendar_completions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** Stable key of the deadline, e.g. `form_1120s:2026` or `sales_tax:<agencyId>:2026-09-30`. */
  deadlineKey: varchar('deadline_key', { length: 120 }).notNull(),
  dueDate: date('due_date').notNull(),
  completedBy: varchar('completed_by', { length: 255 }),
  notes: text('notes'),
}, (table) => [
  uniqueIndex('acct_tax_calendar_completions_uidx').on(table.entityId, table.deadlineKey),
]);

export type AccountingDimensionValue = typeof accountingDimensionValues.$inferSelect;
export type NewAccountingDimensionValue = typeof accountingDimensionValues.$inferInsert;
export type PayrollConnection = typeof payrollConnections.$inferSelect;
export type NewPayrollConnection = typeof payrollConnections.$inferInsert;
export type PayrollImport = typeof payrollImports.$inferSelect;
export type NewPayrollImport = typeof payrollImports.$inferInsert;
export type TaxCalendarCompletion = typeof taxCalendarCompletions.$inferSelect;
export type NewTaxCalendarCompletion = typeof taxCalendarCompletions.$inferInsert;

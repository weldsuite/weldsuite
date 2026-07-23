import {
  pgTable,
  varchar,
  timestamp,
  date,
  index,
} from 'drizzle-orm/pg-core';

export const fiscalPeriods = pgTable('fiscal_periods', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  type: varchar('type', { length: 10 }).notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: varchar('status', { length: 10 }).default('open').notNull(),
  closedAt: timestamp('closed_at'),
  closedBy: varchar('closed_by', { length: 255 }),
}, (table) => [
  index('acct_fiscal_periods_entity_idx').on(table.entityId),
  index('acct_fiscal_periods_start_date_idx').on(table.startDate),
  index('acct_fiscal_periods_end_date_idx').on(table.endDate),
  index('acct_fiscal_periods_status_idx').on(table.status),
]);

export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type NewFiscalPeriod = typeof fiscalPeriods.$inferInsert;

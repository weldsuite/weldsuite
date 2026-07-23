import {
  pgTable,
  varchar,
  timestamp,
  numeric,
  date,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const fxRates = pgTable('fx_rates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  date: date('date').notNull(),
  fromCurrency: varchar('from_currency', { length: 3 }).notNull(),
  toCurrency: varchar('to_currency', { length: 3 }).notNull(),
  rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
  source: varchar('source', { length: 20 }).notNull().default('ecb'),
}, (table) => [
  uniqueIndex('fx_rates_unique').on(
    table.date,
    table.fromCurrency,
    table.toCurrency,
    table.source,
  ),
  index('fx_rates_date_idx').on(table.date),
  index('fx_rates_pair_idx').on(table.fromCurrency, table.toCurrency),
]);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;

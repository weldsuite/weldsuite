import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Cache of VIES (EU VAT Information Exchange System) validation results.
 *
 * A 0%-rated intracommunautaire levering / reverse charge is only valid when
 * the buyer's VAT number checks out in VIES — an invalid number shifts the
 * VAT liability back to the seller. Lookups are cached because VIES is
 * rate-limited and periodically unavailable; `checkedAt` drives the TTL
 * (valid results are trusted longer than invalid ones).
 */
export const viesChecks = pgTable('vies_checks', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  /** Normalized full VAT number, e.g. NL123456789B01. */
  vatNumber: varchar('vat_number', { length: 20 }).notNull().unique(),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  valid: boolean('valid').notNull(),
  /** Trader name/address as registered in VIES (when disclosed by the member state). */
  traderName: varchar('trader_name', { length: 255 }),
  traderAddress: varchar('trader_address', { length: 500 }),
  /** VIES consultation number — proof of verification for the administration. */
  consultationNumber: varchar('consultation_number', { length: 50 }),
  checkedAt: timestamp('checked_at').notNull(),
}, (table) => [
  index('acct_vies_checks_country_idx').on(table.countryCode),
  index('acct_vies_checks_checked_at_idx').on(table.checkedAt),
]);

export type ViesCheck = typeof viesChecks.$inferSelect;
export type NewViesCheck = typeof viesChecks.$inferInsert;

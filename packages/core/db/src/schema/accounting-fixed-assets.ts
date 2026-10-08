import {
  pgTable,
  varchar,
  timestamp,
  date,
  boolean,
  numeric,
  text,
  index,
} from 'drizzle-orm/pg-core';

/** A fixed asset. Depreciation is kept per book in `fixed_asset_books`. */
export const fixedAssets = pgTable('fixed_assets', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  assetNumber: varchar('asset_number', { length: 50 }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  /** MACRS property class: 3 | 5 | 7 | 10 | 15 | 20 | 25 | 27.5 | 39, or a book category. */
  assetClass: varchar('asset_class', { length: 20 }),
  assetAccountId: varchar('asset_account_id', { length: 30 }).notNull(),
  accumulatedDepreciationAccountId: varchar('accumulated_depreciation_account_id', { length: 30 }).notNull(),
  depreciationExpenseAccountId: varchar('depreciation_expense_account_id', { length: 30 }).notNull(),
  acquisitionDate: date('acquisition_date').notNull(),
  placedInServiceDate: date('placed_in_service_date').notNull(),
  cost: numeric('cost', { precision: 18, scale: 2 }).notNull(),
  salvageValue: numeric('salvage_value', { precision: 18, scale: 2 }).notNull().default('0'),
  /** Share of business use (listed property below 50% must use ADS). */
  businessUsePercent: numeric('business_use_percent', { precision: 7, scale: 4 }).notNull().default('100'),
  billId: varchar('bill_id', { length: 30 }),
  billItemId: varchar('bill_item_id', { length: 30 }),
  /** active | fully_depreciated | disposed */
  status: varchar('status', { length: 20 }).notNull().default('active'),
  disposalDate: date('disposal_date'),
  disposalProceeds: numeric('disposal_proceeds', { precision: 18, scale: 2 }),
  disposalJournalEntryId: varchar('disposal_journal_entry_id', { length: 30 }),
  classId: varchar('class_id', { length: 30 }),
  locationId: varchar('location_id', { length: 30 }),
  notes: text('notes'),
}, (table) => [
  index('acct_fixed_assets_entity_idx').on(table.entityId),
  index('acct_fixed_assets_status_idx').on(table.status),
]);

/**
 * A depreciation book for an asset: `book` (GAAP, posts to the ledger),
 * `federal` (MACRS, for the return) and optionally `state`.
 */
export const fixedAssetBooks = pgTable('fixed_asset_books', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  assetId: varchar('asset_id', { length: 30 }).notNull(),
  /** book | federal | state */
  book: varchar('book', { length: 10 }).notNull(),
  stateCode: varchar('state_code', { length: 2 }),
  /** straight_line | declining_balance | macrs_gds | macrs_ads | expensed | none */
  method: varchar('method', { length: 20 }).notNull(),
  /** half_year | mid_quarter | mid_month | full_month */
  convention: varchar('convention', { length: 15 }).notNull().default('full_month'),
  recoveryYears: numeric('recovery_years', { precision: 5, scale: 1 }).notNull(),
  section179Amount: numeric('section_179_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  bonusPercent: numeric('bonus_percent', { precision: 7, scale: 4 }).notNull().default('0'),
  /** Cost × business use − salvage (book) or − §179 − bonus (tax). */
  depreciableBasis: numeric('depreciable_basis', { precision: 18, scale: 2 }).notNull(),
  /** Only the `book` book posts journal entries. */
  postsToLedger: boolean('posts_to_ledger').notNull().default(false),
}, (table) => [
  index('acct_fixed_asset_books_asset_idx').on(table.assetId),
]);

/** One depreciation amount per book and period; `book` rows get a journal entry when posted. */
export const fixedAssetDepreciation = pgTable('fixed_asset_depreciation', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  assetId: varchar('asset_id', { length: 30 }).notNull(),
  bookId: varchar('book_id', { length: 30 }).notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  accumulated: numeric('accumulated', { precision: 18, scale: 2 }).notNull(),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
}, (table) => [
  index('acct_fixed_asset_dep_asset_idx').on(table.assetId, table.periodStart),
  index('acct_fixed_asset_dep_book_idx').on(table.bookId),
]);

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type NewFixedAsset = typeof fixedAssets.$inferInsert;
export type FixedAssetBook = typeof fixedAssetBooks.$inferSelect;
export type NewFixedAssetBook = typeof fixedAssetBooks.$inferInsert;
export type FixedAssetDepreciation = typeof fixedAssetDepreciation.$inferSelect;
export type NewFixedAssetDepreciation = typeof fixedAssetDepreciation.$inferInsert;

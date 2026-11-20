import {
  pgTable,
  varchar,
  timestamp,
  integer,
  smallint,
  boolean,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldStash replenishment: demand forecasting and reorder suggestions
 * (weldsuite-documentation/plans/weldstash-replenishment.md, phases 2 to 5). Served by the Rust
 * backend only (`rust/modules/stash`); the TypeScript stash-api does not read
 * these tables.
 *
 * An "item" is a product (or variant) in a warehouse. `item_key` is
 * `<productId>|<variantId or ''>|<warehouseId>`, written by the service, so
 * the run can upsert on one plain unique column.
 */

// Replenishment settings - one row per tenant database (id 'default').
export const stashSettings = pgTable('stash_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  replenishmentEnabled: boolean('replenishment_enabled').notNull().default(false),
  defaultServiceLevel: numeric('default_service_level', { precision: 4, scale: 3 }).notNull().default('0.950'),
  defaultReviewPeriodDays: integer('default_review_period_days').notNull().default(7),
  lookbackDays: integer('lookback_days').notNull().default(365),
  defaultLeadTimeDays: integer('default_lead_time_days').notNull().default(14),
  /** Where an order without a pick list counts. Null: the warehouse with `is_default`. */
  demandWarehouseId: varchar('demand_warehouse_id', { length: 30 }),
  /** Imported sales history counts only before this date; orders count from it. */
  historyCutoverDate: date('history_cutover_date'),
  /** Hour (UTC) of the nightly planning run. */
  runHourUtc: smallint('run_hour_utc').notNull().default(2),
});

export type StashSettings = typeof stashSettings.$inferSelect;
export type NewStashSettings = typeof stashSettings.$inferInsert;

// Reorder rules - optional per-item inputs. No row: workspace defaults, method auto.
export const stashReorderRules = pgTable('stash_reorder_rules', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  itemKey: varchar('item_key', { length: 100 }).notNull(),
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),

  method: varchar('method', { length: 20 }).notNull().default('auto'), // auto, min_max, off
  minQty: integer('min_qty'),
  maxQty: integer('max_qty'),
  serviceLevel: numeric('service_level', { precision: 4, scale: 3 }),
  reviewPeriodDays: integer('review_period_days'),
  leadTimeDaysOverride: integer('lead_time_days_override'),
  /** Overrides the preferred product supplier. */
  productSupplierId: varchar('product_supplier_id', { length: 30 }),
}, (table) => [
  uniqueIndex('stash_reorder_rules_item_unique').on(table.itemKey),
  index('stash_reorder_rules_product_idx').on(table.productId),
]);

export type StashReorderRule = typeof stashReorderRules.$inferSelect;
export type NewStashReorderRule = typeof stashReorderRules.$inferInsert;

// Item plans - the planning run's output, one row per item, upserted by every run.
// A run overwrites the computed columns and leaves the review columns alone.
export const stashItemPlans = pgTable('stash_item_plans', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  itemKey: varchar('item_key', { length: 100 }).notNull(),
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  warehouseId: varchar('warehouse_id', { length: 30 }).notNull(),

  // Run
  runId: varchar('run_id', { length: 30 }),
  computedAt: timestamp('computed_at'),
  method: varchar('method', { length: 20 }).notNull().default('none'), // seasonal, level, sparse, min_max, none
  confidence: varchar('confidence', { length: 10 }).notNull().default('none'), // none, low, ok
  historyDays: integer('history_days').notNull().default(0),
  nonzeroDays: integer('nonzero_days').notNull().default(0),

  // Demand
  avgDailyDemand: numeric('avg_daily_demand', { precision: 14, scale: 4 }),
  demandStdDev: numeric('demand_std_dev', { precision: 14, scale: 4 }),
  /** Twelve monthly indices (January first), or null without a year of history. */
  seasonality: jsonb('seasonality').$type<number[]>(),
  forecast30d: numeric('forecast_30d', { precision: 14, scale: 4 }),
  forecast90d: numeric('forecast_90d', { precision: 14, scale: 4 }),

  // Inputs used
  leadTimeDays: integer('lead_time_days'),
  reviewPeriodDays: integer('review_period_days'),
  serviceLevel: numeric('service_level', { precision: 4, scale: 3 }),
  productSupplierId: varchar('product_supplier_id', { length: 30 }),
  supplierId: varchar('supplier_id', { length: 30 }),

  // Policy
  safetyStock: integer('safety_stock'),
  reorderPoint: integer('reorder_point'),
  orderUpTo: integer('order_up_to'),

  // Position (snapshots at run time)
  onHand: integer('on_hand').notNull().default(0),
  allocated: integer('allocated').notNull().default(0),
  incoming: integer('incoming').notNull().default(0),
  openDemand: integer('open_demand').notNull().default(0),
  inventoryPosition: integer('inventory_position').notNull().default(0),

  // Outlook
  daysOfCover: numeric('days_of_cover', { precision: 10, scale: 1 }),
  stockoutDate: date('stockout_date'),

  // Suggestion
  suggestedQty: integer('suggested_qty').notNull().default(0),
  suggestedValue: numeric('suggested_value', { precision: 18, scale: 2 }),

  // Review
  reviewStatus: varchar('review_status', { length: 20 }).notNull().default('none'), // none, open, dismissed, ordered
  dismissedUntil: timestamp('dismissed_until'),
  dismissedBy: varchar('dismissed_by', { length: 255 }),
  /** Suggested quantity when dismissed: a run reopens the plan once it grows by more than half. */
  dismissedQty: integer('dismissed_qty'),
  purchaseOrderId: varchar('purchase_order_id', { length: 30 }),
}, (table) => [
  uniqueIndex('stash_item_plans_item_unique').on(table.itemKey),
  index('stash_item_plans_review_idx').on(table.reviewStatus),
  index('stash_item_plans_supplier_idx').on(table.supplierId),
  index('stash_item_plans_warehouse_idx').on(table.warehouseId),
]);

export type StashItemPlan = typeof stashItemPlans.$inferSelect;
export type NewStashItemPlan = typeof stashItemPlans.$inferInsert;

// Planning runs - one row per run, for "last calculated" and troubleshooting. Kept 90 days.
export const stashPlanningRuns = pgTable('stash_planning_runs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  trigger: varchar('trigger', { length: 20 }).notNull(), // schedule, manual
  status: varchar('status', { length: 20 }).notNull().default('running'), // running, done, failed
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
  itemsPlanned: integer('items_planned').notNull().default(0),
  itemsToReorder: integer('items_to_reorder').notNull().default(0),
  error: varchar('error', { length: 1000 }),
  startedBy: varchar('started_by', { length: 255 }),
}, (table) => [
  index('stash_planning_runs_started_idx').on(table.startedAt),
]);

export type StashPlanningRun = typeof stashPlanningRuns.$inferSelect;
export type NewStashPlanningRun = typeof stashPlanningRuns.$inferInsert;

// Sales history - demand that is not a WeldCommerce order (ADR STASH-009):
// imported from a CSV file, or synced from Odoo. Never fulfilled or invoiced.
export const stashSalesHistory = pgTable('stash_sales_history', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  date: date('date').notNull(),
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  /** Null: the demand warehouse. */
  warehouseId: varchar('warehouse_id', { length: 30 }),
  /** In the product's base unit. */
  quantity: integer('quantity').notNull(),
  source: varchar('source', { length: 20 }).notNull(), // import, odoo
  importId: varchar('import_id', { length: 30 }),
  connectionId: varchar('connection_id', { length: 30 }),
  /** The source's own id (an Odoo sale order line id, an import reference). */
  externalRef: varchar('external_ref', { length: 255 }),
}, (table) => [
  index('stash_sales_history_product_date_idx').on(table.productId, table.date),
  index('stash_sales_history_import_idx').on(table.importId),
  uniqueIndex('stash_sales_history_external_unique').on(table.connectionId, table.externalRef),
]);

export type StashSalesHistory = typeof stashSalesHistory.$inferSelect;
export type NewStashSalesHistory = typeof stashSalesHistory.$inferInsert;

// Sales history imports - one row per uploaded file. Deleting an import deletes its rows.
export const stashSalesHistoryImports = pgTable('stash_sales_history_imports', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  fileName: varchar('file_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('processing'), // processing, done, failed
  rowsTotal: integer('rows_total').notNull().default(0),
  rowsImported: integer('rows_imported').notNull().default(0),
  rowsSkipped: integer('rows_skipped').notNull().default(0),
  /** The first 100 SKUs that matched no product. */
  unmatchedSkus: jsonb('unmatched_skus').$type<string[]>(),
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('stash_sales_history_imports_created_idx').on(table.createdAt),
]);

export type StashSalesHistoryImport = typeof stashSalesHistoryImports.$inferSelect;
export type NewStashSalesHistoryImport = typeof stashSalesHistoryImports.$inferInsert;

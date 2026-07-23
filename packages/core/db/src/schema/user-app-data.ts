import { pgTable, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ============================================================================
// WELDAPPS — APP DATA (TENANT DATABASE)
//
// Generic per-app storage for user-created apps. Apps declare collections in
// their manifest and get CRUD + jsonb filtering through external-api's
// /v1/app-storage routes — no per-app tables or migrations, ever.
// The tenant DB is per-workspace, so rows need no workspaceId column
// (same model as workspace_installed_apps).
// ============================================================================

// Collection records — one row per record, grouped by (appCode, collection)
export const appRecords = pgTable('app_records', {
  id: varchar('id', { length: 30 }).primaryKey(),

  appCode: varchar('app_code', { length: 50 }).notNull(),
  collection: varchar('collection', { length: 100 }).notNull(),

  data: jsonb('data').$type<Record<string, unknown>>().notNull(),

  // App token id or user id that created/last touched the record
  createdBy: varchar('created_by', { length: 255 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('app_records_app_collection_idx').on(table.appCode, table.collection),
  index('app_records_created_at_idx').on(table.createdAt),
]);

export type AppRecord = typeof appRecords.$inferSelect;
export type NewAppRecord = typeof appRecords.$inferInsert;

// Key-value storage — simple per-app settings/state
export const appKv = pgTable('app_kv', {
  id: varchar('id', { length: 30 }).primaryKey(),

  appCode: varchar('app_code', { length: 50 }).notNull(),
  key: varchar('key', { length: 255 }).notNull(),
  value: jsonb('value').$type<unknown>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('app_kv_app_key_idx').on(table.appCode, table.key),
]);

export type AppKvEntry = typeof appKv.$inferSelect;
export type NewAppKvEntry = typeof appKv.$inferInsert;

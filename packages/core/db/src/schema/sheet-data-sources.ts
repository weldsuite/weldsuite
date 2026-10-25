import { pgTable, varchar, timestamp, index, integer, jsonb, text } from 'drizzle-orm/pg-core';
import { sheets } from './sheets';

/** When a connected table refreshes on its own (besides on demand). */
export type SheetDataRefresh = 'manual' | 'hourly' | 'daily';

/** One condition on a field of the object a connected table lists. */
export interface SheetDataFilter {
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';
  value?: string | number | boolean | null;
}

/** What a connected table lists: fields as columns, in order, and which records. */
export interface SheetDataDefinition {
  columns: string[];
  /** Titles of the columns, written as the table's first row (in the connecting person's words). */
  headers: string[];
  filters: SheetDataFilter[];
  sort?: { field: string; descending?: boolean };
  /** Records at most. */
  limit: number;
}

/**
 * WeldSheets connected tables: live WeldSuite data in a spreadsheet.
 *
 * Each row is a list of one WeldSuite object (CRM customers, tickets,
 * invoices, …) that sheets-api writes into a sheet as cells, refreshed on
 * demand or on a schedule. Where it writes lives in the workbook (the
 * sheet's `dataTables`), so it moves with rows and columns and co-edits;
 * this row holds what to list, whose access lists it (`created_by_id`) and
 * how its last refresh went.
 */
export const sheetDataSources = pgTable(
  'sheet_data_sources',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** The spreadsheet it fills (sheets.id); goes with the sheet. */
    sheetId: varchar('sheet_id', { length: 255 })
      .notNull()
      .references(() => sheets.id, { onDelete: 'cascade' }),

    /** The WeldSuite object listed (sheets-api's catalog key, e.g. `customers`). */
    objectType: varchar('object_type', { length: 50 }).notNull(),

    definition: jsonb('definition').$type<SheetDataDefinition>().notNull(),

    refresh: varchar('refresh', { length: 20 }).$type<SheetDataRefresh>().notNull().default('manual'),

    lastRefreshedAt: timestamp('last_refreshed_at'),
    /** When a scheduled refresh is next due; null for `manual`. */
    nextRefreshAt: timestamp('next_refresh_at'),
    /** Why the last refresh failed; null after one that worked. */
    lastError: text('last_error'),
    /** Records the last refresh wrote. */
    rowCount: integer('row_count').notNull().default(0),

    /** Who connected it: refreshes list only what this person may read. */
    createdById: varchar('created_by_id', { length: 255 }).notNull(),
  },
  (table) => [index('sheet_data_sources_sheet_idx').on(table.sheetId)],
);

export type SheetDataSourceRow = typeof sheetDataSources.$inferSelect;
export type NewSheetDataSourceRow = typeof sheetDataSources.$inferInsert;

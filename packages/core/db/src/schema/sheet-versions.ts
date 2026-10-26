import { pgTable, varchar, timestamp, index, integer } from 'drizzle-orm/pg-core';
import { sheets } from './sheets';

/**
 * WeldSheets version history.
 *
 * Each row is a saved copy of a spreadsheet (`sheets`) at one revision: the
 * whole workbook as a gzipped snapshot in R2 (private bucket, under the
 * sheet's own key prefix), written by sheets-api. A person names a version
 * (`name`); restoring one first saves the sheet as it was as an automatic
 * version (`name` null), so a restore can always be undone.
 *
 * Comments live inside the workbook, so a version carries the comments of
 * its moment. Same shape as WeldDocs' `doc_versions`.
 */
export const sheetVersions = pgTable(
  'sheet_versions',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /**
     * The spreadsheet this is a version of (sheets.id). Versions go with the
     * sheet when the drive purges it from the trash.
     */
    sheetId: varchar('sheet_id', { length: 255 })
      .notNull()
      .references(() => sheets.id, { onDelete: 'cascade' }),

    /** The room's revision the snapshot is at. */
    revision: integer('revision').notNull(),

    /** What the person called it; null for an automatic version (saved before a restore). */
    name: varchar('name', { length: 255 }),

    /** R2 key (private bucket) of the snapshot. */
    snapshotKey: varchar('snapshot_key', { length: 1000 }).notNull(),

    /** Size of the stored snapshot, bytes. */
    size: integer('size').notNull().default(0),

    /** User who saved the version (or whose restore saved it). */
    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [index('sheet_versions_sheet_idx').on(table.sheetId, table.createdAt)],
);

export type SheetVersionRow = typeof sheetVersions.$inferSelect;
export type NewSheetVersionRow = typeof sheetVersions.$inferInsert;

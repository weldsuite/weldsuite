import { pgTable, varchar, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldSheets — native spreadsheet documents.
 *
 * One row per spreadsheet, paired 1:1 with a drive `files` row (so the sheet
 * shows up in WeldDrive, folders, trash, search). The workbook itself is not
 * stored here: the sheet's SheetRoom Durable Object (sheets-api) orders every
 * edit, keeps the ops since its last checkpoint in its own storage, and
 * checkpoints the whole workbook to R2. This row records where the latest
 * checkpoint is, so code outside the room can read the sheet.
 *
 * Kept in its own table (not on `files.metadata`) so the room's bookkeeping
 * stays out of WeldDrive's file-list queries.
 */
export const sheets = pgTable(
  'sheets',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** The drive file this sheet is backed by (files.id). */
    fileId: varchar('file_id', { length: 255 })
      .notNull()
      .references(() => files.id),

    /** Latest revision the room has reported (the live room may be a few ops ahead). */
    revision: integer('revision').notNull().default(0),

    /** R2 key (private bucket) of the latest checkpoint; null until the first one (an empty workbook). */
    snapshotKey: varchar('snapshot_key', { length: 1000 }),

    /** Revision the checkpoint at `snapshotKey` is at. */
    snapshotRevision: integer('snapshot_revision').notNull().default(0),

    /** User who last edited the sheet. */
    updatedById: varchar('updated_by_id', { length: 255 }),
  },
  (table) => [index('sheets_file_idx').on(table.fileId)],
);

export type Sheet = typeof sheets.$inferSelect;
export type NewSheet = typeof sheets.$inferInsert;

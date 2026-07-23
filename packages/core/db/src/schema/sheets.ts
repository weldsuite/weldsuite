import { pgTable, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldSheets — native spreadsheet documents.
 *
 * One row per spreadsheet, paired 1:1 with a drive `files` row (so the sheet
 * shows up in WeldDrive, folders, trash, search). The canonical document is
 * the Univer workbook snapshot stored in `snapshot` (jsonb). xlsx/csv/ods are
 * derived on demand from this snapshot by the WeldSheets app (SheetJS) — they
 * are never the source of truth.
 *
 * Kept in its own table (not on `files.metadata`) so the snapshot blob stays
 * out of WeldDrive's file-list queries.
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

    /** Univer workbook snapshot (IWorkbookData). */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),

    /** User who last saved the sheet. */
    updatedById: varchar('updated_by_id', { length: 255 }),
  },
  (table) => [index('sheets_file_idx').on(table.fileId)],
);

export type Sheet = typeof sheets.$inferSelect;
export type NewSheet = typeof sheets.$inferInsert;

import { pgTable, varchar, timestamp, index, integer } from 'drizzle-orm/pg-core';
import { docs } from './docs';

/**
 * WeldDocs version history.
 *
 * Each row is a saved copy of a WeldDocs document (`docs`) at one revision:
 * the whole document as a gzipped snapshot in R2 (private bucket, under the
 * document's own key prefix), written by docs-api. A person names a version
 * (`name`); restoring one first saves the document as it was as an automatic
 * version (`name` null), so a restore can always be undone.
 *
 * Comments live inside the document, so a version carries the comments of
 * its moment. `document_versions` is the older BlockNote history.
 */
export const docVersions = pgTable(
  'doc_versions',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /**
     * The document this is a version of (docs.id). Versions go with the
     * document when the drive purges it from the trash.
     */
    docId: varchar('doc_id', { length: 255 })
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),

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
  (table) => [index('doc_versions_doc_idx').on(table.docId, table.createdAt)],
);

export type DocVersionRow = typeof docVersions.$inferSelect;
export type NewDocVersionRow = typeof docVersions.$inferInsert;

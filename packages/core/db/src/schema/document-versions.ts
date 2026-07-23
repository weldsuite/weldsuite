import { pgTable, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * Document version history.
 *
 * Each row is an immutable snapshot of a document's BlockNote block JSON at a
 * point in time, paired with the backing drive `files` row. Snapshots are
 * created automatically (throttled) on save and explicitly as named versions;
 * a restore writes a snapshot's content back onto the live `docs` row.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /** The drive file this version belongs to (files.id). */
    fileId: varchar('file_id', { length: 255 })
      .notNull()
      .references(() => files.id),

    /** BlockNote block JSON snapshot. */
    content: jsonb('content').$type<Record<string, unknown>[]>().notNull(),

    /** Optional label for a named version (null = automatic snapshot). */
    label: varchar('label', { length: 255 }),

    /** User who created the snapshot. */
    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [index('document_versions_file_idx').on(table.fileId, table.createdAt)],
);

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;

import { pgTable, varchar, timestamp, jsonb, index, text, integer } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldDocs: native documents.
 *
 * One row per document, paired 1:1 with a drive `files` row (so the document
 * shows up in WeldDrive, folders, trash, search). A WeldDocs document is not
 * stored here: its DocRoom Durable Object (docs-api) orders every edit, keeps
 * the ops since its last checkpoint in its own storage, and checkpoints the
 * whole document to R2. This row records where the latest checkpoint is, so
 * code outside the room can read the document. `content` is null for these.
 *
 * Documents from before WeldDocs keep their BlockNote block JSON in `content`
 * (flow-api `/api/documents`, which refuses to write to a WeldDocs row); phase
 * 8 of docs/plans/welddocs.md converts them. docx/pdf are derived on demand,
 * never the source of truth. `yjsState` was reserved for a Yjs design that
 * was not built and stays null.
 *
 * Named `docs` (not `documents`) because WeldBooks already owns a `documents`
 * table. Kept in its own table (not on `files.metadata`) so the room's
 * bookkeeping stays out of WeldDrive's file-list queries.
 */
export const docs = pgTable(
  'docs',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** The drive file this document is backed by (files.id). */
    fileId: varchar('file_id', { length: 255 })
      .notNull()
      .references(() => files.id),

    /**
     * BlockNote block JSON of a document from before WeldDocs. Null for a
     * WeldDocs document, whose content lives in its DocRoom and the room's R2
     * checkpoints; phase 8 converts the old ones.
     */
    content: jsonb('content').$type<Record<string, unknown>[]>(),

    /** Latest revision the room has reported (the live room may be a few ops ahead). */
    revision: integer('revision').notNull().default(0),

    /** R2 key (private bucket) of the latest checkpoint; null for a document from before WeldDocs. */
    snapshotKey: varchar('snapshot_key', { length: 1000 }),

    /** Revision the checkpoint at `snapshotKey` is at. */
    snapshotRevision: integer('snapshot_revision').notNull().default(0),

    /** Unused: reserved for a Yjs design that was not built. */
    yjsState: text('yjs_state'),

    /** User who last edited the document. */
    updatedById: varchar('updated_by_id', { length: 255 }),
  },
  (table) => [index('docs_file_idx').on(table.fileId)],
);

export type Doc = typeof docs.$inferSelect;
export type NewDoc = typeof docs.$inferInsert;

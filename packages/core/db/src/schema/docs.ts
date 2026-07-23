import { pgTable, varchar, timestamp, jsonb, index, text } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldDocs — native rich-text documents (the unified document store).
 *
 * One row per document, paired 1:1 with a drive `files` row (so the document
 * shows up in WeldDrive, folders, trash, search). The canonical document is
 * the BlockNote block JSON stored in `content` (jsonb). docx/pdf are derived
 * on demand — they are never the source of truth.
 *
 * `yjsState` is the authoritative Yjs (CRDT) state blob once live multiplayer
 * is enabled; `content` is kept in sync as a readable/searchable snapshot.
 * Until collaboration is wired (Phase 3) `yjsState` stays null and `content`
 * alone is the source of truth.
 *
 * Named `docs` (not `documents`) because WeldBooks already owns a `documents`
 * table. Kept in its own table (not on `files.metadata`) so the content blob
 * stays out of WeldDrive's file-list queries.
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

    /** BlockNote block JSON — the readable/searchable document snapshot. */
    content: jsonb('content').$type<Record<string, unknown>[]>().notNull(),

    /**
     * Authoritative Yjs (CRDT) state — base64-encoded `Y.encodeStateAsUpdate`
     * blob. Null until live collaboration is wired (Phase 3); `content` is the
     * source of truth until then.
     */
    yjsState: text('yjs_state'),

    /** User who last saved the document. */
    updatedById: varchar('updated_by_id', { length: 255 }),
  },
  (table) => [index('docs_file_idx').on(table.fileId)],
);

export type Doc = typeof docs.$inferSelect;
export type NewDoc = typeof docs.$inferInsert;

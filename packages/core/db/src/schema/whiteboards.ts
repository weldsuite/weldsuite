import { pgTable, varchar, timestamp, integer, boolean, index, jsonb } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldBoard boards (docs/plans/weldboard.md).
 *
 * One row per board, paired 1:1 with a drive `files` row (so the board shows
 * up in WeldDrive, folders, trash, search). The board itself is not here:
 * its room (board-api's BoardRoom) keeps the ops since its last checkpoint,
 * and checkpoints go to R2 (private bucket) at `snapshot_key`. This row says
 * where the latest checkpoint is and at which revision.
 *
 * A WeldFlow project's whiteboard is a board whose file has `entity_type`
 * 'project'. One converted from the old `project_whiteboards` keeps that
 * row's id (`pwb_…`), so links and API ids keep working.
 *
 * Distinct from `project_whiteboards` (WeldFlow's old format), which stays
 * read-only for the converter and the compatibility API.
 */
export const whiteboards = pgTable(
  'whiteboards',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** The drive file this board is backed by (files.id). */
    fileId: varchar('file_id', { length: 255 })
      .notNull()
      .references(() => files.id),

    /** Latest revision the room has reported (the live room may be a few ops ahead). */
    revision: integer('revision').notNull().default(0),

    /** R2 key (private bucket) of the latest checkpoint. */
    snapshotKey: varchar('snapshot_key', { length: 1000 }),

    /** Revision the checkpoint at `snapshotKey` is at. */
    snapshotRevision: integer('snapshot_revision').notNull().default(0),

    /** A workspace template: everyone may start a board from it. */
    isTemplate: boolean('is_template').notNull().default(false),

    /** The template gallery's category (meetings, ideation, planning, strategy, diagramming, other). */
    templateCategory: varchar('template_category', { length: 32 }),

    /** User who last changed the board (as of the last checkpoint). */
    updatedById: varchar('updated_by_id', { length: 255 }),

    /**
     * Deprecated: the Excalidraw scene this table was first shaped for. No
     * code ever wrote it; it stays (nullable) until every tenant database has
     * been checked to hold no rows, then a later migration drops it.
     */
    scene: jsonb('scene').$type<Record<string, unknown>>(),
  },
  (table) => [index('whiteboards_file_idx').on(table.fileId), index('whiteboards_template_idx').on(table.isTemplate)],
);

export type Whiteboard = typeof whiteboards.$inferSelect;
export type NewWhiteboard = typeof whiteboards.$inferInsert;

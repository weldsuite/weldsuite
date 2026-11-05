import { pgTable, varchar, timestamp, index, integer } from 'drizzle-orm/pg-core';
import { whiteboards } from './whiteboards';

/**
 * WeldBoard version history.
 *
 * Each row is a saved copy of a board (`whiteboards`) at one revision: the
 * whole board as a gzipped snapshot in R2 (private bucket, under the board's
 * own key prefix), written by board-api. A person names a version (`name`);
 * restoring one first saves the board as it was as an automatic version
 * (`name` null), so a restore can always be undone.
 */
export const boardVersions = pgTable(
  'board_versions',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /** The board this is a version of. Versions go with the board when the drive purges it. */
    boardId: varchar('board_id', { length: 255 })
      .notNull()
      .references(() => whiteboards.id, { onDelete: 'cascade' }),

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
  (table) => [index('board_versions_board_idx').on(table.boardId, table.createdAt)],
);

export type BoardVersionRow = typeof boardVersions.$inferSelect;
export type NewBoardVersionRow = typeof boardVersions.$inferInsert;

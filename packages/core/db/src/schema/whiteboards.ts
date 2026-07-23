import { pgTable, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { files } from './files';

/**
 * WeldBoard — native whiteboards.
 *
 * One row per whiteboard, paired 1:1 with a drive `files` row (so the board
 * shows up in WeldDrive, folders, trash, search). The canonical document is
 * the Excalidraw scene ({ elements, appState, files }) stored in `scene`
 * (jsonb), saved wholesale by the WeldBoard app on every change.
 *
 * Distinct from `project_whiteboards` (WeldFlow's project-scoped whiteboards).
 * Kept in its own table (not on `files.metadata`) so the scene blob stays out
 * of WeldDrive's file-list queries.
 */
export const whiteboards = pgTable(
  'whiteboards',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** The drive file this whiteboard is backed by (files.id). */
    fileId: varchar('file_id', { length: 255 })
      .notNull()
      .references(() => files.id),

    /** Excalidraw scene snapshot ({ elements, appState, files }). */
    scene: jsonb('scene').$type<Record<string, unknown>>().notNull(),

    /** User who last saved the whiteboard. */
    updatedById: varchar('updated_by_id', { length: 255 }),
  },
  (table) => [index('whiteboards_file_idx').on(table.fileId)],
);

export type Whiteboard = typeof whiteboards.$inferSelect;
export type NewWhiteboard = typeof whiteboards.$inferInsert;

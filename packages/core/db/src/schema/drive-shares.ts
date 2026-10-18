import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { files } from './files';
import { folders } from './folders';

/**
 * Who a Drive file or folder is open to, besides its owner and the people it
 * is shared with (`files.general_access`, `folders.general_access`):
 *
 *   workspace_edit  everyone with Drive access opens and edits it (the default)
 *   workspace_view  everyone opens it; only the owner and editors change it
 *   restricted      only the owner and the people it is shared with
 *
 * The strictest setting on the way up the folder tree applies, so a file in a
 * restricted folder is restricted too. The rule lives in
 * `@weldsuite/core-domain/drive-access`.
 */
export type DriveGeneralAccess = 'workspace_edit' | 'workspace_view' | 'restricted';

/** A teammate's role on a shared Drive item. Editors may also share it. */
export type DriveShareRole = 'viewer' | 'editor';

/**
 * One Drive file or folder shared with one workspace member. A folder share
 * reaches everything inside the folder. Exactly one of `fileId` / `folderId`
 * is set; the row goes when the item is purged.
 */
export const driveShares = pgTable(
  'drive_shares',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    fileId: varchar('file_id', { length: 255 }).references(() => files.id, { onDelete: 'cascade' }),
    folderId: varchar('folder_id', { length: 255 }).references(() => folders.id, { onDelete: 'cascade' }),
    /** Clerk user id, matching `workspace_members.user_id`. */
    userId: varchar('user_id', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).$type<DriveShareRole>().notNull(),
    sharedBy: varchar('shared_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('drive_shares_file_user_idx').on(table.fileId, table.userId),
    uniqueIndex('drive_shares_folder_user_idx').on(table.folderId, table.userId),
    index('drive_shares_user_idx').on(table.userId),
    check('drive_shares_one_item_check', sql`num_nonnulls(${table.fileId}, ${table.folderId}) = 1`),
  ],
);

export type DriveShare = typeof driveShares.$inferSelect;
export type NewDriveShare = typeof driveShares.$inferInsert;

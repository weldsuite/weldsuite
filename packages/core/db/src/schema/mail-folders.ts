import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { mailAccounts } from './mail-accounts';

// Folder type enum
export const mailFolderTypeEnum = pgEnum('mail_folder_type', [
  'inbox',
  'sent',
  'drafts',
  'spam',
  'trash',
  'archive',
  'custom',
]);

// Sync status enum (reuse from mail-accounts or define separately)
export const mailFolderSyncStatusEnum = pgEnum('mail_folder_sync_status', [
  'idle',
  'syncing',
  'completed',
  'error',
  'paused',
]);

// Mail Folders table
export const mailFolders = pgTable('mail_folders', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Folder Information
  name: varchar('name', { length: 255 }).notNull(),
  type: mailFolderTypeEnum('type').notNull().default('custom'),
  parentId: varchar('parent_id', { length: 30 }), // For nested folders
  path: varchar('path', { length: 1000 }), // Full folder path

  // Counts
  totalCount: integer('total_count').notNull().default(0),
  unreadCount: integer('unread_count').notNull().default(0),
  unseenCount: integer('unseen_count').default(0),

  // Sync info (IMAP specific)
  lastSyncAt: timestamp('last_sync_at'),
  syncStatus: mailFolderSyncStatusEnum('sync_status').default('idle'),
  uidValidity: integer('uid_validity'), // IMAP UID validity
  uidNext: integer('uid_next'), // Next expected UID

  // Settings
  isSelectable: boolean('is_selectable').notNull().default(true),
  isSubscribed: boolean('is_subscribed').default(true),
  color: varchar('color', { length: 7 }), // Hex color code
  icon: varchar('icon', { length: 50 }),
  position: integer('position').notNull().default(0),

  // System folder flags
  isSystem: boolean('is_system').default(false),
  specialUse: jsonb('special_use').$type<string[]>(), // IMAP special-use flags

  // External sync
  externalFolderId: varchar('external_folder_id', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_folders_account_id_idx').on(table.accountId),
  index('mail_folders_type_idx').on(table.type),
  index('mail_folders_parent_id_idx').on(table.parentId),
  index('mail_folders_is_system_idx').on(table.isSystem),
]);

export type MailFolder = typeof mailFolders.$inferSelect;
export type NewMailFolder = typeof mailFolders.$inferInsert;

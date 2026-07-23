import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Changelog types
export type ChangelogStatus = 'draft' | 'published';
export type ChangeType = 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking';

export interface ChangelogChange {
  id: string;
  type: ChangeType;
  description: string;
  issueNumber?: string;
}

export const helpdeskChangelog = pgTable('helpdesk_changelog', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Version info
  version: varchar('version', { length: 50 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull(),
  releaseDate: timestamp('release_date').notNull(),

  // Status & Type
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  type: varchar('type', { length: 20 }).notNull().default('feature'),

  // Changes
  changes: jsonb('changes').$type<ChangelogChange[]>(),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),
}, (table) => [
  index('helpdesk_changelog_status_idx').on(table.status),
  index('helpdesk_changelog_version_idx').on(table.version),
  index('helpdesk_changelog_release_date_idx').on(table.releaseDate),
]);

export type HelpdeskChangelogEntry = typeof helpdeskChangelog.$inferSelect;
export type NewHelpdeskChangelogEntry = typeof helpdeskChangelog.$inferInsert;

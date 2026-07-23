import { pgTable, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { knowledgePages } from './knowledge-pages';

/**
 * Knowledge-page version history.
 *
 * Each row is an immutable snapshot of a page's BlockNote block JSON at a
 * point in time. Snapshots are created automatically (throttled) on save and
 * explicitly as named versions; a restore writes a snapshot's content back
 * onto the live `knowledge_pages` row. Mirrors `document_versions`.
 */
export const knowledgePageVersions = pgTable(
  'knowledge_page_versions',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /** The page this version belongs to (knowledge_pages.id). */
    pageId: varchar('page_id', { length: 255 })
      .notNull()
      .references(() => knowledgePages.id),

    /** BlockNote block JSON snapshot. */
    content: jsonb('content').$type<Record<string, unknown>[]>().notNull(),

    /** Optional label for a named version (null = automatic snapshot). */
    label: varchar('label', { length: 255 }),

    /** User who created the snapshot. */
    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [index('knowledge_page_versions_page_idx').on(table.pageId, table.createdAt)],
);

export type KnowledgePageVersion = typeof knowledgePageVersions.$inferSelect;
export type NewKnowledgePageVersion = typeof knowledgePageVersions.$inferInsert;

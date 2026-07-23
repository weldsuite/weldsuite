import { pgTable, varchar, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { knowledgePages } from './knowledge-pages';

/**
 * Per-user knowledge-page favorites, shown pinned at the top of the WeldKnow
 * sidebar. `userId` always comes from the authenticated session — never from
 * client input.
 */
export const knowledgeFavorites = pgTable(
  'knowledge_favorites',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    pageId: varchar('page_id', { length: 255 })
      .notNull()
      .references(() => knowledgePages.id),
    userId: varchar('user_id', { length: 255 }).notNull(),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    uniqueIndex('knowledge_favorites_page_user_idx').on(table.pageId, table.userId),
    index('knowledge_favorites_user_idx').on(table.userId),
  ],
);

export type KnowledgeFavorite = typeof knowledgeFavorites.$inferSelect;
export type NewKnowledgeFavorite = typeof knowledgeFavorites.$inferInsert;

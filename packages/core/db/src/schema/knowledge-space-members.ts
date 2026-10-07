import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { knowledgeSpaces } from './knowledge-spaces';

/**
 * owner  — also edit the teamspace's settings and manage its members
 * editor — create, edit, move and delete pages
 * viewer — read pages only
 */
export type KnowledgeSpaceRole = 'owner' | 'editor' | 'viewer';

/**
 * Who is in a teamspace. Personal spaces have no rows here.
 *
 * Leaving or being removed sets `leftAt` instead of deleting the row, so a
 * default teamspace does not pull that person back in on their next visit.
 * Adding them again clears it.
 */
export const knowledgeSpaceMembers = pgTable(
  'knowledge_space_members',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    spaceId: varchar('space_id', { length: 255 })
      .notNull()
      .references(() => knowledgeSpaces.id),
    /** Clerk user id, matching `workspace_members.user_id`. */
    userId: varchar('user_id', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).$type<KnowledgeSpaceRole>().notNull(),

    addedBy: varchar('added_by', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    leftAt: timestamp('left_at'),
  },
  (table) => [
    uniqueIndex('knowledge_space_members_space_user_idx').on(table.spaceId, table.userId),
    index('knowledge_space_members_user_idx').on(table.userId),
  ],
);

export type KnowledgeSpaceMember = typeof knowledgeSpaceMembers.$inferSelect;
export type NewKnowledgeSpaceMember = typeof knowledgeSpaceMembers.$inferInsert;

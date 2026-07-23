import { pgTable, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

/**
 * WeldKnow knowledge-base spaces — top-level sections of the workspace wiki
 * (like Notion teamspaces). Pages live inside exactly one space.
 */
export const knowledgeSpaces = pgTable(
  'knowledge_spaces',
  {
    // BaseEntity fields
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    // Space info
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 100 }),
    color: varchar('color', { length: 50 }),

    /** 'workspace' = visible to everyone with knowledge:read; 'private' = creator only. */
    visibility: varchar('visibility', { length: 20 }).notNull().default('workspace'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: varchar('created_by', { length: 255 }),
  },
  (table) => [index('knowledge_spaces_sort_order_idx').on(table.sortOrder)],
);

export type KnowledgeSpace = typeof knowledgeSpaces.$inferSelect;
export type NewKnowledgeSpace = typeof knowledgeSpaces.$inferInsert;

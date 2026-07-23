import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { knowledgeSpaces } from './knowledge-spaces';

/**
 * WeldKnow knowledge-base pages — the workspace wiki (Notion/Odoo Knowledge
 * style). Pages form a tree via `parentId` + `position` within a space.
 * Content is BlockNote block JSON (`contentJson`); `contentText` holds a
 * plain-text extraction so federated search can match body text without
 * parsing JSONB.
 */
export const knowledgePages = pgTable(
  'knowledge_pages',
  {
    // BaseEntity fields
    id: varchar('id', { length: 255 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    // Reference
    spaceId: varchar('space_id', { length: 255 })
      .notNull()
      .references(() => knowledgeSpaces.id),

    // Hierarchy (nested pages)
    parentId: varchar('parent_id', { length: 255 }),
    position: integer('position').notNull().default(0),

    // Page info
    title: varchar('title', { length: 500 }).notNull().default('Untitled'),

    // Block editor content (BlockNote JSON) + plain-text extraction for search
    contentJson: jsonb('content_json').$type<Record<string, unknown>[]>(),
    contentText: text('content_text'),

    // Visual
    icon: varchar('icon', { length: 100 }),
    coverImage: varchar('cover_image', { length: 1000 }),

    /** Locked pages reject content edits until unlocked. */
    isLocked: boolean('is_locked').notNull().default(false),

    // Editing info
    createdBy: varchar('created_by', { length: 255 }),
    lastEditedBy: varchar('last_edited_by', { length: 255 }),
  },
  (table) => [
    index('knowledge_pages_space_idx').on(table.spaceId),
    index('knowledge_pages_parent_idx').on(table.parentId),
    index('knowledge_pages_parent_position_idx').on(table.parentId, table.position),
    index('knowledge_pages_deleted_idx').on(table.deletedAt),
  ],
);

export type KnowledgePage = typeof knowledgePages.$inferSelect;
export type NewKnowledgePage = typeof knowledgePages.$inferInsert;

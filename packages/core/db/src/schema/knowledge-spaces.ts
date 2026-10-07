import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * personal — the one private section each person gets, created on first use.
 *            Only its owner can open it; it has no member rows.
 * team     — a teamspace. Who can open it follows `visibility` + membership.
 */
export type KnowledgeSpaceKind = 'personal' | 'team';

/**
 * open    — everyone with knowledge:read can find it and read its pages;
 *           joining (one click) makes them an editor.
 * closed  — everyone can see it exists and who owns it; only members read it.
 * private — only members (and admins holding knowledge:manage) know it exists.
 */
export type KnowledgeSpaceVisibility = 'open' | 'closed' | 'private';

/**
 * WeldKnow knowledge-base spaces — the Notion-style teamspaces of the
 * workspace wiki, plus one personal "Private" space per person. Pages live
 * inside exactly one space.
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

    kind: varchar('kind', { length: 20 }).$type<KnowledgeSpaceKind>().notNull().default('team'),
    /** Set on a personal space: the one user who can open it. Null for teamspaces. */
    ownerId: varchar('owner_id', { length: 255 }),

    visibility: varchar('visibility', { length: 20 }).$type<KnowledgeSpaceVisibility>().notNull().default('open'),

    /** Default teamspace: every workspace member is added to it as an editor. */
    isDefault: boolean('is_default').notNull().default(false),

    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: varchar('created_by', { length: 255 }),
  },
  (table) => [
    index('knowledge_spaces_sort_order_idx').on(table.sortOrder),
    // One personal space per person. It is created on first use, so two tabs
    // opening WeldKnow at once must not end up with two.
    uniqueIndex('knowledge_spaces_personal_owner_idx')
      .on(table.ownerId)
      .where(sql`${table.kind} = 'personal' AND ${table.deletedAt} IS NULL`),
  ],
);

export type KnowledgeSpace = typeof knowledgeSpaces.$inferSelect;
export type NewKnowledgeSpace = typeof knowledgeSpaces.$inferInsert;

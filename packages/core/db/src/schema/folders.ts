import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const folders = pgTable('folders', {
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 500 }).notNull(),
  parentId: varchar('parent_id', { length: 255 }),
  color: varchar('color', { length: 50 }),
  icon: varchar('icon', { length: 50 }),

  createdById: varchar('created_by_id', { length: 255 }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('folders_parent_idx').on(table.parentId),
  index('folders_created_by_idx').on(table.createdById),
]);

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export const chatSections = pgTable('chat_sections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  name: varchar('name', { length: 255 }).notNull(),
  position: integer('position').notNull().default(0),
}, (table) => [
  index('chat_sections_position_idx').on(table.position),
]);

export type ChatSection = typeof chatSections.$inferSelect;
export type NewChatSection = typeof chatSections.$inferInsert;

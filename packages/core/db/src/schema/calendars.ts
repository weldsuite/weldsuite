import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

export const calendars = pgTable('calendars', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Core fields
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  color: varchar('color', { length: 20 }),

  // Ownership
  ownerId: varchar('owner_id', { length: 255 }).notNull(), // Clerk user ID

  // Flags
  isDefault: boolean('is_default').default(false), // Auto-created "My Calendar"
  isActive: boolean('is_active').default(true),
}, (table) => [
  index('calendars_owner_idx').on(table.ownerId),
]);

export type Calendar = typeof calendars.$inferSelect;
export type NewCalendar = typeof calendars.$inferInsert;

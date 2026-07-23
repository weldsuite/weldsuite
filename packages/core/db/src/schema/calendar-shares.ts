import {
  pgTable,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const calendarShares = pgTable('calendar_shares', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References
  calendarId: varchar('calendar_id', { length: 30 }).notNull(),

  // Who it's shared with
  sharedWithId: varchar('shared_with_id', { length: 255 }).notNull(), // Clerk user ID

  // Permission level: view = see events, edit = create/modify events, manage = edit + share + delete calendar
  permission: varchar('permission', { length: 20 }).notNull().default('view'),

  // Who shared it
  sharedById: varchar('shared_by_id', { length: 255 }).notNull(), // Clerk user ID
}, (table) => [
  index('calendar_shares_calendar_idx').on(table.calendarId),
  index('calendar_shares_shared_with_idx').on(table.sharedWithId),
  index('calendar_shares_calendar_user_idx').on(table.calendarId, table.sharedWithId),
]);

export type CalendarShare = typeof calendarShares.$inferSelect;
export type NewCalendarShare = typeof calendarShares.$inferInsert;

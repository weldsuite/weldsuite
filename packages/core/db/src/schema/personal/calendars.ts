import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Personal (consumer) calendars — keyed by personalAccountId.
 * Owner-only in v1; no share table.
 */
export const personalCalendars = pgTable('personal_calendars', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),

  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  color: varchar('color', { length: 20 }),

  /** Clerk user ID of the owner (same user as the personal account). */
  ownerId: varchar('owner_id', { length: 255 }).notNull(),

  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
}, (table) => [
  index('personal_calendars_personal_account_idx').on(table.personalAccountId),
  index('personal_calendars_owner_idx').on(table.ownerId),
]);

export type PersonalCalendar = typeof personalCalendars.$inferSelect;
export type NewPersonalCalendar = typeof personalCalendars.$inferInsert;

import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Personal booking pages. Slug is globally unique in the personal DB because
 * the public URL is `/p/{slug}` with no workspace segment.
 */
export const personalCalendarBookingPages = pgTable('personal_calendar_booking_pages', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),

  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  description: text('description'),
  ownerId: varchar('owner_id', { length: 255 }).notNull(),

  duration: integer('duration').notNull(),
  bufferBefore: integer('buffer_before').default(0),
  bufferAfter: integer('buffer_after').default(0),

  color: varchar('color', { length: 20 }),
  isActive: boolean('is_active').default(true),

  locationType: varchar('location_type', { length: 20 }),
  locationValue: varchar('location_value', { length: 500 }),

  availability: jsonb('availability').$type<{
    monday: { start: string; end: string }[];
    tuesday: { start: string; end: string }[];
    wednesday: { start: string; end: string }[];
    thursday: { start: string; end: string }[];
    friday: { start: string; end: string }[];
    saturday: { start: string; end: string }[];
    sunday: { start: string; end: string }[];
  }>().notNull(),
  questions: jsonb('questions').$type<Array<{
    id: string;
    label: string;
    type: 'text' | 'textarea' | 'select';
    required: boolean;
    options?: string[];
  }>>(),
  minNotice: integer('min_notice').default(60),
  maxAdvance: integer('max_advance').default(60),

  confirmationMessage: text('confirmation_message'),
  timezone: varchar('timezone', { length: 100 }).notNull().default('UTC'),
}, (table) => [
  index('personal_calendar_booking_pages_personal_account_idx').on(table.personalAccountId),
  index('personal_calendar_booking_pages_owner_idx').on(table.ownerId),
  uniqueIndex('personal_calendar_booking_pages_slug_idx').on(table.slug),
  index('personal_calendar_booking_pages_active_idx').on(table.isActive),
]);

export type PersonalCalendarBookingPage = typeof personalCalendarBookingPages.$inferSelect;
export type NewPersonalCalendarBookingPage = typeof personalCalendarBookingPages.$inferInsert;

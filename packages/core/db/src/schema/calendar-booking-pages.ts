import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const calendarBookingPages = pgTable('calendar_booking_pages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Core fields
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  description: text('description'),
  ownerId: varchar('owner_id', { length: 255 }).notNull(), // Clerk user ID

  // Duration & buffers
  duration: integer('duration').notNull(), // minutes
  bufferBefore: integer('buffer_before').default(0), // minutes
  bufferAfter: integer('buffer_after').default(0), // minutes

  // Appearance
  color: varchar('color', { length: 20 }),
  isActive: boolean('is_active').default(true),

  // Location
  locationType: varchar('location_type', { length: 20 }), // 'in-person' | 'phone' | 'video'
  locationValue: varchar('location_value', { length: 500 }),

  // Availability & booking rules
  availability: jsonb('availability').$type<{
    monday: { start: string; end: string }[];
    tuesday: { start: string; end: string }[];
    wednesday: { start: string; end: string }[];
    thursday: { start: string; end: string }[];
    friday: { start: string; end: string }[];
    saturday: { start: string; end: string }[];
    sunday: { start: string; end: string }[];
  }>().notNull(), // WeeklyAvailability object
  questions: jsonb('questions').$type<Array<{
    id: string;
    label: string;
    type: 'text' | 'textarea' | 'select';
    required: boolean;
    options?: string[];
  }>>(), // BookingQuestion[]
  minNotice: integer('min_notice').default(60), // minutes ahead required
  maxAdvance: integer('max_advance').default(60), // days ahead allowed

  // Confirmation
  confirmationMessage: text('confirmation_message'),

  // Timezone — IANA name; slots are generated in this tz regardless of server tz
  timezone: varchar('timezone', { length: 100 }).notNull().default('UTC'),
}, (table) => [
  index('calendar_booking_pages_owner_idx').on(table.ownerId),
  index('calendar_booking_pages_slug_idx').on(table.slug),
  index('calendar_booking_pages_active_idx').on(table.isActive),
]);

export type CalendarBookingPage = typeof calendarBookingPages.$inferSelect;
export type NewCalendarBookingPage = typeof calendarBookingPages.$inferInsert;

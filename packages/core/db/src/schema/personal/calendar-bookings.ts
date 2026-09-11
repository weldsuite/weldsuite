import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const personalCalendarBookings = pgTable('personal_calendar_bookings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),

  bookingPageId: varchar('booking_page_id', { length: 30 }).notNull(),
  calendarEventId: varchar('calendar_event_id', { length: 30 }),

  bookerName: varchar('booker_name', { length: 255 }).notNull(),
  bookerEmail: varchar('booker_email', { length: 255 }).notNull(),

  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time').notNull(),

  status: varchar('status', { length: 20 }).notNull().default('confirmed'),

  answers: jsonb('answers').$type<Record<string, unknown>>(),
  notes: text('notes'),
  guests: jsonb('guests').$type<{ email: string; name?: string }[]>(),

  timezone: varchar('timezone', { length: 100 }),

  cancelledAt: timestamp('cancelled_at'),
  cancelReason: text('cancel_reason'),
}, (table) => [
  index('personal_calendar_bookings_personal_account_idx').on(table.personalAccountId),
  index('personal_calendar_bookings_page_idx').on(table.bookingPageId),
  index('personal_calendar_bookings_email_idx').on(table.bookerEmail),
  index('personal_calendar_bookings_start_time_idx').on(table.startTime),
  index('personal_calendar_bookings_status_idx').on(table.status),
]);

export type PersonalCalendarBooking = typeof personalCalendarBookings.$inferSelect;
export type NewPersonalCalendarBooking = typeof personalCalendarBookings.$inferInsert;

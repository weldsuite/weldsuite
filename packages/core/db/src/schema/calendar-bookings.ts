import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const calendarBookings = pgTable('calendar_bookings', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References
  bookingPageId: varchar('booking_page_id', { length: 30 }).notNull(),
  calendarEventId: varchar('calendar_event_id', { length: 30 }), // link to created calendar event

  // Booker info
  bookerName: varchar('booker_name', { length: 255 }).notNull(),
  bookerEmail: varchar('booker_email', { length: 255 }).notNull(),

  // Timing
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time').notNull(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('confirmed'), // 'confirmed' | 'cancelled' | 'rescheduled'

  // Booking details
  answers: jsonb('answers').$type<Record<string, unknown>>(), // responses to booking page questions
  notes: text('notes'),
  guests: jsonb('guests').$type<{ email: string; name?: string }[]>(),

  // Timezone the slot was booked under (owner's tz at booking time)
  timezone: varchar('timezone', { length: 100 }),

  // Cancellation
  cancelledAt: timestamp('cancelled_at'),
  cancelReason: text('cancel_reason'),
}, (table) => [
  index('calendar_bookings_page_idx').on(table.bookingPageId),
  index('calendar_bookings_email_idx').on(table.bookerEmail),
  index('calendar_bookings_start_time_idx').on(table.startTime),
  index('calendar_bookings_status_idx').on(table.status),
]);

export type CalendarBooking = typeof calendarBookings.$inferSelect;
export type NewCalendarBooking = typeof calendarBookings.$inferInsert;

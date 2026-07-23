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

export const calendarEvents = pgTable('calendar_events', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Core fields
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 30 }).notNull(), // 'meeting' | 'call' | 'appointment' | 'event' | 'reminder' | 'other'

  // Timing
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time'),
  allDay: boolean('all_day').default(false),
  timezone: varchar('timezone', { length: 50 }),

  // Location
  location: varchar('location', { length: 500 }),
  isVirtual: boolean('is_virtual').default(false),
  meetingUrl: varchar('meeting_url', { length: 1000 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('confirmed'), // 'confirmed' | 'tentative' | 'cancelled'
  priority: varchar('priority', { length: 10 }).default('normal'), // 'low' | 'normal' | 'high' | 'urgent'
  color: varchar('color', { length: 20 }),

  // Recurrence
  recurrenceRule: varchar('recurrence_rule', { length: 500 }), // RRULE string
  recurrenceId: varchar('recurrence_id', { length: 30 }), // parent event ID for recurrence instances

  // Calendar & Ownership
  calendarId: varchar('calendar_id', { length: 30 }).notNull(), // references calendars.id
  organizerId: varchar('organizer_id', { length: 255 }).notNull(), // Clerk user ID

  // Participants
  attendees: jsonb('attendees').$type<{ email: string; name?: string; status?: string; role?: string }[]>(), // { email: string; name?: string; status?: string; role?: string }[]

  // Reminders
  reminders: jsonb('reminders').$type<{ type: 'email' | 'notification'; minutes: number }[]>(), // { type: 'email' | 'notification'; minutes: number }[]

  // CRM links
  customerId: varchar('customer_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }),

  // Source linking (task/activity auto-scheduling)
  sourceType: varchar('source_type', { length: 20 }), // 'task' | 'activity' | null — what entity created this event
  sourceId: varchar('source_id', { length: 30 }), // ID of the linked entity (e.g. task ID or activity ID)
  autoScheduled: boolean('auto_scheduled').default(false), // true if placed by the scheduling algorithm
  reason: text('reason'), // why the scheduling algorithm placed the event here
  taskPriority: varchar('task_priority', { length: 20 }), // priority carried over from the source task, for display without a join

  // Additional
  notes: text('notes'),
  attachments: jsonb('attachments').$type<string[]>(), // string[]
  tags: jsonb('tags').$type<string[]>(), // string[]
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(), // Record<string, unknown>
}, (table) => [
  index('calendar_events_calendar_idx').on(table.calendarId),
  index('calendar_events_type_idx').on(table.type),
  index('calendar_events_organizer_idx').on(table.organizerId),
  index('calendar_events_start_time_idx').on(table.startTime),
  index('calendar_events_status_idx').on(table.status),
  index('calendar_events_customer_idx').on(table.customerId),
  index('calendar_events_contact_idx').on(table.contactId),
  index('calendar_events_recurrence_idx').on(table.recurrenceId),
  index('calendar_events_source_idx').on(table.sourceType, table.sourceId),
  index('calendar_events_auto_scheduled_idx').on(table.autoScheduled),
]);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;

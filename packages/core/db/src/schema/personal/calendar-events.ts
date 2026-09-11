import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Personal calendar events. CRM / task auto-schedule columns are omitted —
 * those are workspace-only.
 */
export const personalCalendarEvents = pgTable('personal_calendar_events', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),

  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 30 }).notNull(),

  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time'),
  allDay: boolean('all_day').default(false),
  timezone: varchar('timezone', { length: 50 }),

  location: varchar('location', { length: 500 }),
  isVirtual: boolean('is_virtual').default(false),
  meetingUrl: varchar('meeting_url', { length: 1000 }),

  status: varchar('status', { length: 20 }).notNull().default('confirmed'),
  priority: varchar('priority', { length: 10 }).default('normal'),
  color: varchar('color', { length: 20 }),

  recurrenceRule: varchar('recurrence_rule', { length: 500 }),
  recurrenceId: varchar('recurrence_id', { length: 30 }),

  calendarId: varchar('calendar_id', { length: 30 }).notNull(),
  organizerId: varchar('organizer_id', { length: 255 }).notNull(),

  attendees: jsonb('attendees').$type<{ email: string; name?: string; status?: string; role?: string }[]>(),
  reminders: jsonb('reminders').$type<{ type: 'email' | 'notification'; minutes: number }[]>(),

  notes: text('notes'),
  attachments: jsonb('attachments').$type<string[]>(),
  tags: jsonb('tags').$type<string[]>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
}, (table) => [
  index('personal_calendar_events_personal_account_idx').on(table.personalAccountId),
  index('personal_calendar_events_calendar_idx').on(table.calendarId),
  index('personal_calendar_events_type_idx').on(table.type),
  index('personal_calendar_events_organizer_idx').on(table.organizerId),
  index('personal_calendar_events_start_time_idx').on(table.startTime),
  index('personal_calendar_events_status_idx').on(table.status),
  index('personal_calendar_events_recurrence_idx').on(table.recurrenceId),
]);

export type PersonalCalendarEvent = typeof personalCalendarEvents.$inferSelect;
export type NewPersonalCalendarEvent = typeof personalCalendarEvents.$inferInsert;

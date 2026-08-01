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

export const crmActivities = pgTable('crm_activities', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Type
  type: varchar('type', { length: 30 }).notNull(), // 'call' | 'email' | 'meeting' | 'task' | 'note' | 'sms' | 'linkedin' | 'demo' | 'presentation'
  subject: varchar('subject', { length: 255 }).notNull(),
  description: text('description'),

  // Related To
  relatedTo: varchar('related_to', { length: 20 }), // 'customer' | 'contact' | 'lead' | 'opportunity' | 'campaign' | 'quote'
  relatedToId: varchar('related_to_id', { length: 30 }),
  relatedToName: varchar('related_to_name', { length: 255 }),

  // Participants
  customerId: varchar('customer_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }),
  // New shape — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  leadId: varchar('lead_id', { length: 30 }),
  opportunityId: varchar('opportunity_id', { length: 30 }),
  assignedToId: varchar('assigned_to_id', { length: 255 }).notNull(), // Clerk user ID

  // Timing
  dueDate: timestamp('due_date'),
  startTime: timestamp('start_time'),
  endTime: timestamp('end_time'),
  duration: integer('duration'), // minutes

  // Status
  status: varchar('status', { length: 20 }).notNull().default('planned'), // 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'deferred'
  priority: varchar('priority', { length: 10 }).default('medium'), // 'high' | 'medium' | 'low'

  // Location
  location: varchar('location', { length: 500 }),
  isVirtual: boolean('is_virtual').default(false),
  meetingUrl: varchar('meeting_url', { length: 1000 }),

  // Call Specific
  callDirection: varchar('call_direction', { length: 10 }), // 'inbound' | 'outbound'
  callDuration: integer('call_duration'), // seconds
  callRecordingUrl: varchar('call_recording_url', { length: 1000 }),

  // Email Specific
  emailMessageId: varchar('email_message_id', { length: 255 }),
  emailSubject: varchar('email_subject', { length: 500 }),
  emailFrom: varchar('email_from', { length: 255 }),
  emailTo: jsonb('email_to').$type<string[]>(), // string[]
  emailCc: jsonb('email_cc').$type<string[]>(), // string[]

  // Meeting Specific
  attendees: jsonb('attendees').$type<string[]>(), // string[]
  meetingAgenda: text('meeting_agenda'),
  meetingNotes: text('meeting_notes'),

  // Outcome
  outcome: varchar('outcome', { length: 500 }),
  nextAction: varchar('next_action', { length: 500 }),
  followUpDate: timestamp('follow_up_date'),

  // Attachments
  attachments: jsonb('attachments').$type<string[]>(), // string[]

  // Calendar sync
  calendarEventId: varchar('calendar_event_id', { length: 30 }),

  // User flags
  // Note-specific: starred / favorited from the standalone /weldcrm/notes page.
  // Boolean rather than a flag in customFields so it's queryable + indexable.
  isFavorite: boolean('is_favorite').default(false),

  // Metadata
  tags: jsonb('tags').$type<string[]>(), // string[]
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(), // Record<string, unknown>

  // Extracted from custom_fields blob (see docs/custom-fields-blob-extraction.md)
  labels: jsonb('labels').$type<string[]>(), // string[]
  assigneeIds: jsonb('assignee_ids').$type<string[]>(), // string[]
  repeat: jsonb('repeat').$type<Record<string, unknown>>(), // recurrence config

  // Legacy/read-only: consolidates the old blob keys `changes`, `__changeLog`,
  // `changedFields`, `previousValues`, `newValues`. Their writer was the
  // api-worker (deleted 2026-07-17); the CRM activity feed still reads this.
  // Do not write new data here going forward.
  changeLog: jsonb('change_log').$type<Record<string, unknown>>(),
}, (table) => [
  index('crm_activities_type_idx').on(table.type),
  index('crm_activities_customer_idx').on(table.customerId),
  index('crm_activities_contact_idx').on(table.contactId),
  index('crm_activities_counterparty_idx').on(table.counterpartyId),
  index('crm_activities_person_idx').on(table.personId),
  index('crm_activities_lead_idx').on(table.leadId),
  index('crm_activities_opportunity_idx').on(table.opportunityId),
  index('crm_activities_assigned_to_idx').on(table.assignedToId),
  index('crm_activities_status_idx').on(table.status),
  index('crm_activities_due_date_idx').on(table.dueDate),
  index('crm_activities_calendar_event_idx').on(table.calendarEventId),
]);

export type CrmActivity = typeof crmActivities.$inferSelect;
export type NewCrmActivity = typeof crmActivities.$inferInsert;

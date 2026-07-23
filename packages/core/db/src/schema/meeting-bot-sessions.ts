import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Meeting bot session status enum values
 */
export const MEETING_BOT_STATUS = [
  'pending',      // Just created, waiting to acquire bot
  'joining',      // Bot acquiring, attempting to join
  'connected',    // Bot in meeting
  'recording',    // Actively recording
  'processing',   // Post-processing (transcription, etc.)
  'completed',    // Successfully finished
  'failed',       // Error occurred
  'left',         // Bot left meeting
] as const;
export type MeetingBotStatus = (typeof MEETING_BOT_STATUS)[number];

/**
 * Meeting bot instance status enum values
 */
export const MEETING_BOT_INSTANCE_STATUS = [
  'available',    // Ready for assignment
  'busy',         // Actively processing a meeting
  'offline',      // Not responding
  'error',        // Had an error
] as const;
export type MeetingBotInstanceStatus = (typeof MEETING_BOT_INSTANCE_STATUS)[number];

/**
 * Supported meeting platforms
 */
export const MEETING_PLATFORMS = ['google_meet', 'microsoft_teams', 'zoom'] as const;
export type MeetingPlatform = (typeof MEETING_PLATFORMS)[number];

/**
 * Meeting bot session - tracks each bot session with meeting details
 */
export const meetingBotSessions = pgTable('meeting_bot_sessions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // User who initiated the session
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Meeting details
  meetingUrl: text('meeting_url').notNull(),
  meetingId: varchar('meeting_id', { length: 255 }), // External meeting ID (from platform)
  platform: varchar('platform', { length: 50 }).notNull(), // google_meet, microsoft_teams, zoom
  title: varchar('title', { length: 500 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  errorMessage: text('error_message'),

  // Timing
  joinedAt: timestamp('joined_at'),
  leftAt: timestamp('left_at'),
  duration: integer('duration'), // Duration in seconds

  // Participants
  participantCount: integer('participant_count'),

  // Transcription settings
  enableTranscription: boolean('enable_transcription').default(false),
  enableDiarization: boolean('enable_diarization').default(true),
  language: varchar('language', { length: 10 }).default('en'),

  // CRM linking
  contactId: varchar('contact_id', { length: 30 }),
  // New — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  opportunityId: varchar('opportunity_id', { length: 30 }),
  activityId: varchar('activity_id', { length: 30 }), // Link to CRM activity after completion

  // External bot tracking
  externalBotInstanceId: varchar('external_bot_instance_id', { length: 100 }),
  externalSessionId: varchar('external_session_id', { length: 255 }),
  externalRecordingId: varchar('external_recording_id', { length: 255 }),

  // Recording storage
  recordingStorageUrl: text('recording_storage_url'),
  recordingStorageKey: varchar('recording_storage_key', { length: 500 }),
  recordingFileSize: integer('recording_file_size'),
  recordingDuration: integer('recording_duration'), // Duration in seconds
}, (table) => [
  index('meeting_bot_sessions_user_idx').on(table.userId),
  index('meeting_bot_sessions_status_idx').on(table.status),
  index('meeting_bot_sessions_platform_idx').on(table.platform),
  index('meeting_bot_sessions_contact_idx').on(table.contactId),
  index('meeting_bot_sessions_counterparty_idx').on(table.counterpartyId),
  index('meeting_bot_sessions_person_idx').on(table.personId),
  index('meeting_bot_sessions_opportunity_idx').on(table.opportunityId),
  index('meeting_bot_sessions_external_session_idx').on(table.externalSessionId),
]);

/**
 * Meeting bot instances - tracks available bots in the pool
 */
export const meetingBotInstances = pgTable('meeting_bot_instances', {
  // BaseEntity fields
  id: varchar('id', { length: 100 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Instance details
  name: varchar('name', { length: 255 }).notNull(),
  serviceUrl: text('service_url').notNull(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('available'),
  lastHealthCheck: timestamp('last_health_check'),
  lastError: text('last_error'),

  // Current session (if busy)
  currentSessionId: varchar('current_session_id', { length: 30 }),

  // Statistics
  totalMeetingsProcessed: integer('total_meetings_processed').default(0),
  totalRecordingMinutes: integer('total_recording_minutes').default(0),

  // Configuration
  isEnabled: boolean('is_enabled').default(true),
  priority: integer('priority').default(0), // Higher = more preferred
}, (table) => [
  index('meeting_bot_instances_status_idx').on(table.status),
]);

export type MeetingBotSession = typeof meetingBotSessions.$inferSelect;
export type NewMeetingBotSession = typeof meetingBotSessions.$inferInsert;
export type MeetingBotInstance = typeof meetingBotInstances.$inferSelect;
export type NewMeetingBotInstance = typeof meetingBotInstances.$inferInsert;

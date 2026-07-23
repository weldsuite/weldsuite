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
import { meetings } from './meetings';

// Session types
export type MeetingSessionType = 'video' | 'audio';
export type MeetingSessionStatus = 'waiting' | 'active' | 'ended';

// Participant shape stored in JSONB (same shape as ChatCallParticipant)
export interface MeetingSessionParticipant {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
  cfSessionId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  hasScreenShare: boolean;
  /**
   * Set when the participant was matched to an internal workspace member.
   * Mutually exclusive with `personId` / `contactId` — the participant resolver
   * guarantees only one is populated per participant.
   */
  workspaceMemberId?: string;
  /**
   * Set when the participant was matched to (or auto-created as) a person in
   * the new identity layer. Canonical link going forward; used for guests who
   * join via the public join code.
   */
  personId?: string;
  /**
   * @deprecated Use `personId` after the Companies/People migration completes.
   * Kept on historical rows so legacy reads stay intact; new writes target
   * `personId` instead.
   */
  contactId?: string;
}

export const meetingSessions = pgTable('meeting_sessions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Meeting reference
  meetingId: varchar('meeting_id', { length: 30 }).notNull().references(() => meetings.id),

  // Session info
  sessionType: varchar('session_type', { length: 20 }).notNull().default('video'),
  status: varchar('status', { length: 20 }).notNull().default('waiting'),

  // Cloudflare Realtime SFU
  cfAppId: varchar('cf_app_id', { length: 100 }),

  // Initiator
  startedBy: varchar('started_by', { length: 255 }).notNull(),
  startedByName: varchar('started_by_name', { length: 255 }).notNull(),

  // Participants (denormalized JSONB for fast reads)
  participants: jsonb('participants').$type<MeetingSessionParticipant[]>().default([]),

  // Timing
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  duration: integer('duration'),

  // Stats
  maxParticipants: integer('max_participants').notNull().default(0),

  // Recording
  recordingEnabled: boolean('recording_enabled').default(false),
  recordingUrl: text('recording_url'),
  recordingKey: varchar('recording_key', { length: 500 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('meeting_sessions_meeting_idx').on(table.meetingId),
  index('meeting_sessions_status_idx').on(table.status),
  index('meeting_sessions_started_by_idx').on(table.startedBy),
  index('meeting_sessions_created_at_idx').on(table.createdAt),
]);

export type MeetingSession = typeof meetingSessions.$inferSelect;
export type NewMeetingSession = typeof meetingSessions.$inferInsert;

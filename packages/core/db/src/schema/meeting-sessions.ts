import {
  pgTable,
  varchar,
  timestamp,
  integer,
  bigint,
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

/**
 * One Cloudflare RealtimeKit recording of a session. A session can hold several
 * (recording stopped and restarted). Stored in `meeting_sessions.recording_parts`;
 * the flat `recording_*` columns mirror the latest `ready` part.
 */
export interface RecordingPart {
  /** RealtimeKit recording id */
  rtkRecordingId: string;
  /** R2 key (MEETING_RECORDINGS bucket) of the video file */
  videoKey: string | null;
  /** R2 key (MEETING_RECORDINGS bucket) of the audio-only file */
  audioKey: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  /** ISO timestamps */
  startedAt: string | null;
  stoppedAt: string | null;
  status: 'recording' | 'processing' | 'ready' | 'failed';
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
  // `recordingEnabled` = "currently recording".
  recordingEnabled: boolean('recording_enabled').default(false),
  /** @deprecated Legacy (MeetingBaas / expiring RTK URL). Kept for old rows and the backfill; new code uses `recording_*_key`. */
  recordingUrl: text('recording_url'),
  /** @deprecated Legacy: only ever held the RTK meeting id as a "pending" marker. New code uses `recording_video_key` / `recording_audio_key`. */
  recordingKey: varchar('recording_key', { length: 500 }),

  // RealtimeKit recorder (server-owned; clients never write these)
  /** RTK session id (distinct from the RTK meeting id stored in `cf_app_id`). */
  rtkSessionId: varchar('rtk_session_id', { length: 100 }),
  /** null = never recorded; recording | processing | ready | failed | unavailable | deleted */
  recordingStatus: varchar('recording_status', { length: 20 }),
  /** RTK recording id of the latest part */
  recordingRtkId: varchar('recording_rtk_id', { length: 100 }),
  /** R2 key of the video file (MEETING_RECORDINGS bucket) */
  recordingVideoKey: varchar('recording_video_key', { length: 500 }),
  /** R2 key of the audio-only file (MEETING_RECORDINGS bucket) */
  recordingAudioKey: varchar('recording_audio_key', { length: 500 }),
  recordingSizeBytes: bigint('recording_size_bytes', { mode: 'number' }),
  recordingDurationSeconds: integer('recording_duration_seconds'),
  recordingReadyAt: timestamp('recording_ready_at'),
  recordingError: text('recording_error'),
  /** All RTK recordings of the session; flat columns mirror the latest ready part. */
  recordingParts: jsonb('recording_parts').$type<RecordingPart[]>(),

  // AI options chosen at recording start
  aiTranscribeRequested: boolean('ai_transcribe_requested').default(false),
  aiSummarizeRequested: boolean('ai_summarize_requested').default(false),
  /** RTK language code; null = auto-detect */
  aiLanguage: varchar('ai_language', { length: 10 }),
  transcriptionCreditsCharged: integer('transcription_credits_charged'),

  // Summary
  /** pending | processing | completed | failed */
  summaryStatus: varchar('summary_status', { length: 20 }),
  summaryText: text('summary_text'),
  /** markdown | plain_text */
  summaryFormat: varchar('summary_format', { length: 20 }),
  /** rtk | workers_ai */
  summarySource: varchar('summary_source', { length: 20 }),
  summaryGeneratedAt: timestamp('summary_generated_at'),
  summaryError: text('summary_error'),
  summaryCreditsCharged: integer('summary_credits_charged'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('meeting_sessions_meeting_idx').on(table.meetingId),
  index('meeting_sessions_status_idx').on(table.status),
  index('meeting_sessions_started_by_idx').on(table.startedBy),
  index('meeting_sessions_created_at_idx').on(table.createdAt),
  index('meeting_sessions_recording_status_idx').on(table.recordingStatus),
]);

export type MeetingSession = typeof meetingSessions.$inferSelect;
export type NewMeetingSession = typeof meetingSessions.$inferInsert;
